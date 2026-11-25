import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, connect as tcpConnect, type Socket } from 'node:net';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { MongoClient, BSON } from 'mongodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseV2Config, type SshConfig } from '../config/v2.js';
import { createAdapterFactory } from '../runtime/adapters.js';
import { SourceRegistry } from '../runtime/sources.js';
import { OperationJournal } from '../runtime/journal.js';
import { Operations } from '../runtime/operations.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { sshFixture } from './helpers/ssh.js';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(action: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 120; i++) { try { return await action(); } catch { await pause(500); } }
  throw new Error('Disposable write database startup timed out');
}

// Drop a server reply only AFTER it has arrived at the proxy. Admin readback proves the
// write happened, while the MCP caller cannot infer that from its lost acknowledgement.
async function lostReplyProxy(engine: string, targetPort: number) {
  const sockets = new Set<Socket>(); let lost = 0;
  const server = createServer(front => {
    const back = tcpConnect({ host: '127.0.0.1', port: targetPort });
    sockets.add(front); sockets.add(back);
    let input = Buffer.alloc(0), drop = false, requestId = 0;
    front.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (engine === 'mysql') {
        while (input.length >= 4) {
          const size = input.readUIntLE(0, 3) + 4; if (input.length < size) break;
          // mysql2 may include CLIENT_QUERY_ATTRIBUTES parameter/set counts before SQL.
          if (input[4] === 3 && input.subarray(5, size).toString().replace(/^[\x00\x01]+/, '').trim().toUpperCase() === 'COMMIT') drop = true;
          input = input.subarray(size);
        }
      } else if (engine === 'mongo') {
        while (input.length >= 16) {
          const size = input.readInt32LE(0); if (input.length < size) break;
          if (input.readInt32LE(12) === 2013 && input[20] === 0) {
            const doc = BSON.deserialize(input.subarray(21, 21 + input.readInt32LE(21)));
            if (doc.commitTransaction) { drop = true; requestId = input.readInt32LE(4); }
          }
          input = input.subarray(size);
        }
      } else {
        // Dedicated write socket sends AUTH/SELECT then a single EVAL; no pipelined writes.
        if (input.includes(Buffer.from('\r\nEVAL\r\n'))) drop = true;
        if (input.length > 65536) input = Buffer.alloc(0);
      }
      back.write(chunk);
    });
    back.on('data', chunk => {
      if (drop && (engine !== 'mongo' || (chunk.length >= 16 && chunk.readInt32LE(8) === requestId))) {
        lost++; front.destroy(); back.destroy();
      } else front.write(chunk);
    });
    front.on('error', () => {}); back.on('error', () => front.destroy());
    front.on('close', () => { sockets.delete(front); back.destroy(); });
    back.on('close', () => { sockets.delete(back); front.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, count: () => lost,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('isolated controlled writes: native scopes, CAS/TTL, schema drift, transactions, lost replies and real MCP',
  { skip: process.env.DB_MCP_DOCKER_TESTS !== '1', timeout: 360000 }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-write-integration-'));
    const containers: string[] = [], resources: Array<{ close(): Promise<void> }> = [];
    const secret = 'test_' + randomUUID().replaceAll('-', '');
    const envNames = ['DB_MCP_WRITE_MYSQL', 'DB_MCP_WRITE_REDIS', 'DB_MCP_WRITE_MONGO'];
    const previous = envNames.map(name => process.env[name]);
    let sql: mysql.Connection | undefined, redis: ReturnType<typeof createClient> | undefined, mongo: MongoClient | undefined;
    const docker = async (args: string[]) => {
      try { return (await exec('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
      catch (error) { throw new Error('Disposable Docker ' + args[0] + ': ' + String((error as { stderr?: string }).stderr ?? '').replaceAll(secret, '[REDACTED_SECRET]')); }
    };
    const start = async (engine: string, port: number, args: string[]) => {
      const id = await docker(['run', '-d', '--name', 'db-mcp-write-' + engine + '-' + randomUUID().slice(0, 8), '--label', 'db-mcp.isolated-test=true', '-p', '127.0.0.1::' + port, ...args]);
      containers.push(id); return { id, port: Number((await docker(['port', id, String(port)])).split(':').at(-1)) };
    };
    try {
      await writeFile(path.join(dir, 'rs.key'), Buffer.from(randomUUID() + randomUUID()).toString('base64'), { mode: 0o400 });
      const started = await Promise.allSettled([
        start('mysql', 3306, ['-e', 'MYSQL_ROOT_PASSWORD=' + secret, 'mysql:8.4.8']),
        start('redis', 6379, ['redis:7.4.7', 'redis-server', '--requirepass', secret, '--save', '', '--appendonly', 'no']),
        start('mongo', 27017, ['--user', '0:0', '--entrypoint', 'mongod', '--mount', 'type=bind,src=' + path.join(dir, 'rs.key') + ',dst=/rs.key,readonly', 'mongo:7.0.31', '--bind_ip_all', '--replSet', 'rs0', '--keyFile', '/rs.key']),
      ]);
      if (started.some(r => r.status === 'rejected')) throw new Error('Disposable write database launch failed');
      const [s, r, m] = started.map(v => (v as PromiseFulfilledResult<{ id: string; port: number }>).value);
      await until(() => docker(['exec', m.id, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1})']));
      await docker(['exec', m.id, 'mongosh', '--quiet', '--eval', 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})']);
      await until(async () => { const out = await docker(['exec', m.id, 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary']); if (out !== 'true') throw new Error(); });
      await docker(['exec', m.id, 'mongosh', '--quiet', '--eval', 'db.getSiblingDB("admin").createUser({user:"test_admin",pwd:' + JSON.stringify(secret) + ',roles:["root"]})']);
      sql = await until(() => mysql.createConnection({ host: '127.0.0.1', port: s.port, user: 'root', password: secret, connectTimeout: 1000 }));
      redis = createClient({ password: secret, socket: { host: '127.0.0.1', port: r.port, reconnectStrategy: false, connectTimeout: 1000 } });
      redis.on('error', () => {}); await until(() => redis!.connect());
      mongo = new MongoClient(`mongodb://test_admin:${secret}@127.0.0.1:${m.port}/admin`, { directConnection: true, serverSelectionTimeoutMS: 1000 });
      await mongo.connect();
      await sql.query('CREATE DATABASE test'); await sql.query('USE test');
      await sql.query('CREATE TABLE items (tenant INT NOT NULL, id INT NOT NULL, version BIGINT NOT NULL DEFAULT 0, name VARCHAR(128), PRIMARY KEY(tenant,id)) ENGINE=InnoDB');
      await sql.query("CREATE TABLE storage_checks (tenant INT NOT NULL, id INT NOT NULL, version SMALLINT NOT NULL DEFAULT 0, name VARCHAR(128) COLLATE utf8mb4_0900_ai_ci, fixed CHAR(8), amount DECIMAL(6,2), quantity INT, nullable_name VARCHAR(128), payload TEXT, fraction FLOAT, choice ENUM('alpha','beta') COLLATE utf8mb4_0900_ai_ci, selection SET('alpha','beta') COLLATE utf8mb4_0900_ai_ci, moment TIMESTAMP(6) NULL DEFAULT NULL, PRIMARY KEY(tenant,id), CHECK(id<>10 OR quantity=version)) ENGINE=InnoDB");
      await sql.query('CREATE TABLE hidden (id INT)');
      await sql.query("CREATE USER 'writer'@'%' IDENTIFIED BY ?", [secret]);
      await sql.query("GRANT SELECT, INSERT, UPDATE, DELETE ON test.items TO 'writer'@'%'");
      await sql.query("GRANT SELECT, UPDATE ON test.storage_checks TO 'writer'@'%'");
      const guard = (await readFile(path.resolve('docs/mysql-write-guard.sql'), 'utf8')).replace(/^DELIMITER.*$/gm, '').replace('END//', 'END');
      await sql.query(guard); await sql.query("GRANT EXECUTE ON PROCEDURE test.mcp_write_metadata TO 'writer'@'%'");
      await sql.query("INSERT INTO items VALUES (1,1,0,'old'), (1,2,0,'same')");
      await sql.query("INSERT INTO storage_checks (tenant,id,name,fixed,amount,quantity,nullable_name) VALUES (1,1,'old',NULL,NULL,NULL,NULL),(1,2,'cafe',NULL,NULL,NULL,NULL),(1,3,'tail',NULL,NULL,NULL,NULL),(1,4,NULL,'same',NULL,NULL,NULL),(1,5,NULL,NULL,NULL,1,NULL),(1,6,NULL,NULL,1.23,NULL,NULL),(1,7,NULL,NULL,NULL,NULL,NULL),(1,8,NULL,NULL,NULL,1,NULL),(1,9,NULL,NULL,NULL,1,NULL),(1,10,NULL,NULL,NULL,0,NULL),(1,11,NULL,NULL,NULL,NULL,NULL)");
      await sql.query('UPDATE storage_checks SET version=32767 WHERE tenant=1 AND id=9');
      await sql.query('UPDATE storage_checks SET payload=? WHERE tenant=1 AND id=11', ['x'.repeat(1024)]);
      await sql.query("INSERT INTO storage_checks (tenant,id,fraction,choice,selection,moment) VALUES (1,12,1.000001,NULL,NULL,NULL),(1,13,NULL,'alpha',NULL,NULL),(1,14,NULL,NULL,'alpha',NULL),(1,15,NULL,NULL,NULL,'2026-01-01 00:00:00.123456')");
      await redis.sendCommand(['ACL', 'SETUSER', 'writer', 'on', '>' + secret]);
      // Exercise the published permission recipe, so missing internal commands
      // cannot be concealed by a separately maintained, more permissive fixture.
      const aclTemplate = (await readFile(path.resolve('docs/WRITES.md'), 'utf8')).match(/^ACL SETUSER db_mcp_writer .+$/m)?.[0];
      assert.ok(aclTemplate, 'The documented Redis write ACL template must exist');
      await redis.sendCommand(aclTemplate.split(' ').map(token => token === 'db_mcp_writer' ? 'writer' : token === '~dev:*' ? '~tenant:*' : token));
      const db = mongo.db('test'); await db.createCollection('items'); await db.collection<{ _id: string; version: number; name: string }>('items').insertMany([{ _id: 'one', version: 0, name: 'old' }, { _id: 'two', version: 0, name: 'same' }]);
      await db.command({ createRole: 'mcp_writer', privileges: [
        { resource: { db: 'test', collection: 'items' }, actions: ['find','insert','update','remove','listIndexes'] },
        { resource: { db: 'test', collection: '' }, actions: ['listCollections'] },
      ], roles: [] });
      await db.command({ createUser: 'writer', pwd: secret, roles: ['mcp_writer'] });
      process.env[envNames[0]] = secret; process.env[envNames[1]] = secret;
      process.env[envNames[2]] = `mongodb://writer:${secret}@127.0.0.1:${m.port}/test?authSource=test&replicaSet=rs0`;
      const policy = { versionColumn: 'version', writableColumns: ['name'], allowInsert: true, allowUpdate: true, allowDelete: true };
      const sourceConfigs = [
        { id: 'mysql', engine: 'mysql', host: '127.0.0.1', port: s.port, database: 'test', username: 'writer', passwordRef: 'env:' + envNames[0], access: { tier: 'read_write', tables: ['items','storage_checks'], columns: { items: ['tenant','id','version','name'], storage_checks: ['tenant','id','version','name','fixed','amount','quantity','nullable_name','payload','fraction','choice','selection','moment'] }, writes: { metadataGuard: 'mcp_write_metadata', tables: { items: { ...policy, keyColumns: ['tenant','id'] }, storage_checks: { keyColumns: ['tenant','id'], versionColumn: 'version', writableColumns: ['name','fixed','amount','quantity','nullable_name','payload','fraction','choice','selection','moment'], allowUpdate: true } } } } },
        { id: 'redis', engine: 'redis', host: '127.0.0.1', port: r.port, username: 'writer', passwordRef: 'env:' + envNames[1], access: { tier: 'read_write', keyPrefixes: ['tenant:'], writes: { allowCreate: true, allowReplace: true, allowDelete: true } } },
        { id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:' + envNames[2], access: { tier: 'read_write', collections: ['items'], fields: { items: ['_id','version','name'] }, writes: { collections: { items: policy } } } },
      ];
      const runtime = async (sources: Array<(typeof sourceConfigs)[number] & { ssh?: SshConfig }> = sourceConfigs, suffix = randomUUID(), budgets: { maxItemBytes?: number } = {}) => {
        const journalDir = path.join(dir, suffix); await mkdir(journalDir, { mode: 0o700 });
        const config = parseV2Config({ version: 2, instance: { name: 'write-integration', transport: 'stdio', environment: 'test', tier: 'read_write', journal: { directory: journalDir }, budgets: { maxConnections: 12 } },
          sources: sources.map(source => ({ ...source, tls: { mode: 'disabled' }, budgets: { queryTimeoutMs: 2000, connectTimeoutMs: 2000, ...budgets } })) });
        const registry = new SourceRegistry(config, createAdapterFactory()); const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
        const operations = new Operations(registry, journal); resources.push({ close: () => operations.stop() });
        await registry.initialize(); return { config, registry, operations, dispatcher: new Dispatcher(registry, () => {}, operations) };
      };
      const f = await runtime();
      const call = async (name: string, args: Record<string, unknown>, dispatcher = f.dispatcher) => {
        const result = await dispatcher.call(name, args); return JSON.parse(result.content[0].text);
      };
      const prepare = async (sourceId: string, input: Record<string, unknown>, dispatcher = f.dispatcher) => {
        const tool = sourceId === 'mongo' ? 'mongodb_prepare_write' : sourceId + '_prepare_write';
        const data = await call(tool, { sourceId, ...input }, dispatcher); assert.ok(data.operationId, JSON.stringify(data)); return data.operationId;
      };
      const commit = (sourceId: string, operationId: string, dispatcher = f.dispatcher) => call('commit_write', { sourceId, operationId }, dispatcher);
      await t.test('MySQL complete primary key, version conflict, no-change, insert/delete and native scope', async () => {
        const input = { table: 'items', action: 'update', key: { tenant: 1, id: 1 }, expectedVersion: 0, values: { name: 'next' } };
        const id = await prepare('mysql', input);
        assert.equal((await commit('redis', id)).error.code, 'OPERATION_NOT_FOUND');
        assert.equal((await commit('mysql', id)).state, 'success');
        assert.equal((await commit('mysql', id)).state, 'success');
        assert.equal((await call('mysql_prepare_write', { sourceId: 'mysql', ...input })).error.code, 'VERSION_CONFLICT');
        const same = await prepare('mysql', { ...input, key: { tenant: 1, id: 2 }, values: { name: 'same' } }); assert.equal((await commit('mysql', same)).effect, 'no_change');
        const race = await prepare('mysql', { ...input, expectedVersion: 1 }); await sql!.query('UPDATE items SET version=version+1 WHERE tenant=1 AND id=1');
        assert.equal((await commit('mysql', race)).code, 'VERSION_CONFLICT');
        const inserted = await prepare('mysql', { table: 'items', action: 'insert', key: { tenant: 1, id: 3 }, values: { name: 'created' } }); assert.equal((await commit('mysql', inserted)).effect, 'inserted');
        const deleted = await prepare('mysql', { table: 'items', action: 'delete', key: { tenant: 1, id: 3 }, expectedVersion: 0 }); assert.equal((await commit('mysql', deleted)).effect, 'deleted');
        await sql!.query('CREATE UNIQUE INDEX unique_name ON items(name)');
        const rejected = await prepare('mysql', { table: 'items', action: 'insert', key: { tenant: 1, id: 4 }, values: { name: 'same' } });
        const rejectedResult = await commit('mysql', rejected); assert.equal(rejectedResult.state, 'failed'); assert.equal(rejectedResult.code, 'WRITE_REJECTED');
        assert.equal(((await sql!.query('SELECT COUNT(*) AS total FROM items WHERE tenant=1 AND id=4'))[0] as mysql.RowDataPacket[])[0].total, 0);
        await sql!.query('DROP INDEX unique_name ON items');
        const locked = await prepare('mysql', { ...input, key: { tenant: 1, id: 2 }, values: { name: 'locked-attempt' } });
        await sql!.beginTransaction(); await sql!.query('SELECT id FROM items WHERE tenant=1 AND id=2 FOR UPDATE');
        try { assert.equal((await commit('mysql', locked)).state, 'not_started'); }
        finally { await sql!.rollback(); }
        assert.equal((await commit('mysql', locked)).state, 'not_started');
        assert.equal(((await sql!.query('SELECT name,version FROM items WHERE tenant=1 AND id=2'))[0] as mysql.RowDataPacket[])[0].name, 'same');
        const writer = await mysql.createConnection({ host: '127.0.0.1', port: s.port, user: 'writer', password: secret, database: 'test' });
        try { await assert.rejects(writer.query('DELETE FROM hidden')); await assert.rejects(writer.query('DROP TABLE items')); } finally { await writer.end(); }
        const missing = await call('mysql_prepare_write', { sourceId: 'mysql', ...input, key: { tenant: 1, id: 999 } });
        assert.equal(missing.error?.code, 'TARGET_NOT_FOUND');
      });
      await t.test('MySQL schema drift, triggers and cascades close writes before DML', async () => {
        const input = { table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'changed' } };
        const id = await prepare('mysql', input); await sql!.query('ALTER TABLE items ADD note INT');
        assert.equal((await commit('mysql', id)).code, 'SCHEMA_CHANGED');
        await sql!.query('CREATE TRIGGER items_audit BEFORE UPDATE ON items FOR EACH ROW SET NEW.name = NEW.name');
        assert.equal((await call('mysql_prepare_write', { sourceId: 'mysql', ...input })).error.code, 'SCHEMA_UNSAFE');
        await sql!.query('DROP TRIGGER items_audit');
        await sql!.query('CREATE TABLE child (tenant INT, id INT, FOREIGN KEY(tenant,id) REFERENCES items(tenant,id) ON DELETE CASCADE)');
        const denial = await call('mysql_prepare_write', { sourceId: 'mysql', table: 'items', action: 'delete', key: { tenant: 1, id: 2 }, expectedVersion: 0 }); assert.equal(denial.error.code, 'SCHEMA_UNSAFE');
        await sql!.query('DROP TABLE child');
        await sql!.query('CREATE TABLE child (tenant INT, id INT, FOREIGN KEY(tenant,id) REFERENCES items(tenant,id) ON DELETE SET NULL)');
        assert.equal((await call('mysql_prepare_write', { sourceId: 'mysql', table: 'items', action: 'delete', key: { tenant: 1, id: 2 }, expectedVersion: 0 })).error.code, 'SCHEMA_UNSAFE');
        await sql!.query('DROP TABLE child');
        assert.equal((await call('mysql_prepare_write', { sourceId: 'mysql', ...input, key: { tenant: 1, id: '2' } })).error.code, 'SCHEMA_UNSAFE');
        await sql!.query('ALTER TABLE items DROP PRIMARY KEY, ADD PRIMARY KEY(id)');
        assert.equal((await call('mysql_prepare_write', { sourceId: 'mysql', ...input })).error.code, 'SCHEMA_UNSAFE');
        await sql!.query('ALTER TABLE items DROP PRIMARY KEY, ADD PRIMARY KEY(tenant,id)');
      });
      await t.test('MySQL no-change follows actual stored values rather than collation equality', async () => {
        const update = async (id: number, values: Record<string, unknown>, expectedVersion = 0) => commit('mysql', await prepare('mysql', {
          table: 'storage_checks', action: 'update', key: { tenant: 1, id }, expectedVersion, values,
        }));
        const row = async (id: number) => ((await sql!.query('SELECT * FROM storage_checks WHERE tenant=1 AND id=?', [id]))[0] as mysql.RowDataPacket[])[0];
        for (const [id, value] of [[1, 'OLD'], [2, 'caf\u00e9'], [3, 'tail ']] as const) {
          const result = await update(id, { name: value });
          assert.equal(result.effect, 'updated', JSON.stringify(result)); assert.equal(result.directAffected, 1); assert.equal(result.version, 1);
          const actual = await row(id); assert.equal(actual.name, value); assert.equal(actual.version, 1);
          const same = await update(id, { name: value }, 1);
          assert.equal(same.effect, 'no_change'); assert.equal(same.directAffected, 0); assert.equal(same.version, 1);
          assert.equal((await row(id)).version, 1);
        }
        for (const [id, values] of [[4, { fixed: 'same ' }], [5, { quantity: '01' }], [6, { amount: 1.234 }], [7, { nullable_name: null }]] as const) {
          const result = await update(id, values);
          assert.equal(result.effect, 'no_change', JSON.stringify(result)); assert.equal(result.directAffected, 0); assert.equal(result.version, 0);
          assert.equal((await row(id)).version, 0);
        }
        assert.equal((await row(4)).fixed, 'same'); assert.equal((await row(5)).quantity, 1); assert.equal((await row(6)).amount, '1.23');
        assert.equal((await update(7, { nullable_name: 'set' })).effect, 'updated');
        assert.equal((await update(7, { nullable_name: null }, 1)).effect, 'updated');
        const cleared = await row(7); assert.equal(cleared.nullable_name, null); assert.equal(cleared.version, 2);
        const rejected = await update(8, { quantity: 'not-a-number' });
        assert.equal(rejected.state, 'failed'); assert.equal(rejected.code, 'WRITE_REJECTED');
        const retained = await row(8); assert.equal(retained.quantity, 1); assert.equal(retained.version, 0);
      });
      await t.test('MySQL field assignment and version advance remain one atomic CHECK-valid update', async () => {
        const input = { table: 'storage_checks', action: 'update', key: { tenant: 1, id: 10 }, expectedVersion: 0, values: { quantity: 1 } };
        const changed = await commit('mysql', await prepare('mysql', input));
        assert.equal(changed.effect, 'updated', JSON.stringify(changed)); assert.equal(changed.version, 1);
        const same = await commit('mysql', await prepare('mysql', { ...input, expectedVersion: 1 }));
        assert.equal(same.effect, 'no_change'); assert.equal(same.version, 1);
        const rows = (await sql!.query('SELECT quantity,version FROM storage_checks WHERE tenant=1 AND id=10'))[0] as mysql.RowDataPacket[];
        assert.equal(rows[0].quantity, 1); assert.equal(rows[0].version, 1);
      });
      await t.test('MySQL native version ceiling allows no-change and rolls back rejected changes', async () => {
        const input = { table: 'storage_checks', action: 'update', key: { tenant: 1, id: 9 }, expectedVersion: 32767, values: { quantity: 1 } };
        const same = await commit('mysql', await prepare('mysql', input)); assert.equal(same.effect, 'no_change'); assert.equal(same.version, 32767);
        const changed = await commit('mysql', await prepare('mysql', { ...input, values: { quantity: 2 } }));
        assert.equal(changed.state, 'failed'); assert.equal(changed.code, 'WRITE_REJECTED');
        const rows = (await sql!.query('SELECT quantity,version FROM storage_checks WHERE tenant=1 AND id=9'))[0] as mysql.RowDataPacket[];
        assert.equal(rows[0].quantity, 1); assert.equal(rows[0].version, 32767);
      });
      await t.test('MySQL exact before-value capture fails closed above the source byte budget', async () => {
        const limited = await runtime([sourceConfigs[0]], undefined, { maxItemBytes: 256 });
        const id = await prepare('mysql', { table: 'storage_checks', action: 'update', key: { tenant: 1, id: 11 }, expectedVersion: 0, values: { payload: 'short' } }, limited.dispatcher);
        const result = await commit('mysql', id, limited.dispatcher);
        assert.equal(result.state, 'not_started'); assert.equal(result.code, 'BUDGET_EXCEEDED');
        const rows = (await sql!.query('SELECT OCTET_LENGTH(payload) AS bytes,version FROM storage_checks WHERE tenant=1 AND id=11'))[0] as mysql.RowDataPacket[];
        assert.equal(rows[0].bytes, 1024); assert.equal(rows[0].version, 0);
      });
      await t.test('MySQL stored comparisons preserve FLOAT precision, ENUM/SET identity and TIMESTAMP microseconds', async () => {
        const update = async (id: number, values: Record<string, unknown>, expectedVersion = 0) => commit('mysql', await prepare('mysql', {
          table: 'storage_checks', action: 'update', key: { tenant: 1, id }, expectedVersion, values,
        }));
        const read = async (id: number) => ((await sql!.query("SELECT CAST(fraction AS DOUBLE) AS fraction,choice,selection,DATE_FORMAT(moment,'%Y-%m-%d %H:%i:%s.%f') AS moment,version FROM storage_checks WHERE tenant=1 AND id=?", [id]))[0] as mysql.RowDataPacket[])[0];
        const oldFloat = (await read(12)).fraction;
        const floatResult = await update(12, { fraction: 1.000002 });
        assert.equal(floatResult.effect, 'updated'); assert.equal(floatResult.version, 1); assert.notEqual((await read(12)).fraction, oldFloat);
        assert.equal((await update(12, { fraction: 1.000002 }, 1)).effect, 'no_change'); assert.equal((await read(12)).version, 1);
        assert.equal((await update(13, { choice: 2 })).effect, 'updated'); assert.equal((await read(13)).choice, 'beta');
        assert.equal((await update(13, { choice: 'BETA' }, 1)).effect, 'no_change'); assert.equal((await read(13)).version, 1);
        assert.equal((await update(14, { selection: 3 })).effect, 'updated'); assert.equal((await read(14)).selection, 'alpha,beta');
        assert.equal((await update(14, { selection: 'beta,alpha' }, 1)).effect, 'no_change'); assert.equal((await read(14)).version, 1);
        const timestamp = '2026-01-01 00:00:00.123457';
        const timestampResult = await update(15, { moment: timestamp }); assert.equal(timestampResult.effect, 'updated'); assert.equal(timestampResult.version, 1);
        assert.equal((await read(15)).moment, timestamp);
        assert.equal((await update(15, { moment: timestamp }, 1)).effect, 'no_change'); assert.equal((await read(15)).version, 1);
      });
      await t.test('Redis CAS is atomic, keep TTL is explicit, conflicts and key ACL are enforced', async () => {
        const id = await prepare('redis', { key: 'tenant:one', action: 'create', value: 'old', ttl: { mode: 'expire', seconds: 60 } }); assert.equal((await commit('redis', id)).state, 'success');
        const input = { key: 'tenant:one', action: 'replace', value: 'next', expectedValue: 'old', expectedTtl: { mode: 'expiring', minMs: 1000, maxMs: 60000 }, ttl: { mode: 'keep' } };
        const one = await prepare('redis', input), two = await prepare('redis', input);
        const results = await Promise.all([commit('redis', one), commit('redis', two)]); assert.equal(results.filter(v => v.state === 'success').length, 1);
        assert.equal(await redis!.get('tenant:one'), 'next'); assert.ok(await redis!.pTTL('tenant:one') > 1000);
        const deletion = await prepare('redis', { key: 'tenant:one', action: 'delete', expectedValue: 'next', expectedTtl: { mode: 'expiring', minMs: 1000, maxMs: 60000 } }); assert.equal((await commit('redis', deletion)).effect, 'deleted');
        const missing = await call('redis_prepare_write', { sourceId: 'redis', ...input, expectedValue: 'next' }); assert.equal(missing.error?.code, 'TARGET_NOT_FOUND');
        assert.equal((await call('redis_prepare_write', { sourceId: 'redis', key: 'hidden:one', action: 'create', value: 'x', ttl: { mode: 'clear' } })).error.code, 'SCOPE_DENIED');
        const writer = createClient({ username: 'writer', password: secret, socket: { host: '127.0.0.1', port: r.port, reconnectStrategy: false } }); writer.on('error', () => {}); await writer.connect();
        try { await assert.rejects(writer.set('hidden:one', 'x')); await assert.rejects(writer.sendCommand(['FLUSHALL'])); } finally { await writer.disconnect(); }
      });
      await t.test('MySQL and MongoDB version ceiling allows matching, no-change and delete but rolls back a change', async () => {
        const ceiling = Number.MAX_SAFE_INTEGER;
        await sql!.query('INSERT INTO items (tenant, id, version, name) VALUES (?, ?, ?, ?)', [1, 99, ceiling - 1, 'old']);
        const collection = db.collection<{ _id: string; version: number; name: string }>('items');
        await collection.insertOne({ _id: 'version-ceiling', version: ceiling - 1, name: 'old' });
        for (const [sourceId, target] of [['mysql', { table: 'items', key: { tenant: 1, id: 99 } }],
          ['mongo', { collection: 'items', key: { _id: 'version-ceiling' } }]] as const) {
          const change = async (name: string, expectedVersion: number) => commit(sourceId, await prepare(sourceId, {
            ...target, action: 'update', expectedVersion, values: { name },
          }));
          const reached = await change('at-ceiling', ceiling - 1);
          assert.equal(reached.effect, 'updated'); assert.equal(reached.version, ceiling);
          const noChange = await change('at-ceiling', ceiling);
          assert.equal(noChange.effect, 'no_change'); assert.equal(noChange.version, ceiling);
          const rejected = await change('must-roll-back', ceiling);
          assert.equal(rejected.code, 'VERSION_LIMIT_REACHED');
          assert.ok(rejected.state === 'not_started' || rejected.state === 'failed', JSON.stringify(rejected));
          const row = sourceId === 'mysql' ? ((await sql!.query('SELECT name, CAST(version AS CHAR) AS version FROM items WHERE tenant=1 AND id=99'))[0] as mysql.RowDataPacket[])[0] :
            await collection.findOne({ _id: 'version-ceiling' });
          assert.equal(row?.name, 'at-ceiling'); assert.equal(Number(row?.version), ceiling);
          const deleted = await commit(sourceId, await prepare(sourceId, { ...target, action: 'delete', expectedVersion: ceiling }));
          assert.equal(deleted.effect, 'deleted');
        }
      });
      await t.test('MongoDB unique index rejection is durable and leaves later writes available', async () => {
        const collection = db.collection<{ _id: string; version: number; name: string }>('items');
        await collection.createIndex({ name: 1, version: 1 }, { unique: true });
        const insert = { collection: 'items', action: 'insert', key: { _id: 'unique-index-check' }, values: { name: 'same' } };
        const operationId = await prepare('mongo', insert);
        const rejected = await commit('mongo', operationId);
        assert.equal(rejected.state, 'failed');
        assert.equal(rejected.code, 'WRITE_REJECTED');
        const status = await call('operation_status', { sourceId: 'mongo', operationId });
        assert.equal(status.state, 'failed');
        assert.equal(status.code, 'WRITE_REJECTED');
        assert.equal(await collection.findOne({ _id: insert.key._id }), null);
        assert.equal((await call('server_runtime_status', {})).writeBlockedSources.includes('mongo'), false);
        const valid = await prepare('mongo', { ...insert, values: { name: 'new unique value' } });
        assert.equal((await commit('mongo', valid)).state, 'success');
      });
      await t.test('MongoDB _id transaction, versions, no-change, insert/delete and collection generation drift', async () => {
        const input = { collection: 'items', action: 'update', key: { _id: 'one' }, expectedVersion: 0, values: { name: 'next' } };
        const id = await prepare('mongo', input); assert.equal((await commit('mongo', id)).state, 'success');
        assert.equal((await call('mongodb_prepare_write', { sourceId: 'mongo', ...input })).error.code, 'VERSION_CONFLICT');
        const same = await prepare('mongo', { ...input, key: { _id: 'two' }, values: { name: 'same' } }); assert.equal((await commit('mongo', same)).effect, 'no_change');
        const insert = await prepare('mongo', { collection: 'items', action: 'insert', key: { _id: 'three' }, values: { name: 'created' } }); assert.equal((await commit('mongo', insert)).effect, 'inserted');
        const deletion = await prepare('mongo', { collection: 'items', action: 'delete', key: { _id: 'three' }, expectedVersion: 0 }); assert.equal((await commit('mongo', deletion)).effect, 'deleted');
        const drift = await prepare('mongo', { ...input, expectedVersion: 1 }); await db.collection('items').createIndex({ name: 1 });
        assert.equal((await commit('mongo', drift)).code, 'SCHEMA_CHANGED');
        const recreated = await prepare('mongo', { ...input, expectedVersion: 1 });
        await db.collection('items').drop(); await db.createCollection('items');
        await db.collection<{ _id: string; version: number; name: string }>('items').insertMany([{ _id: 'one', version: 1, name: 'next' }, { _id: 'two', version: 0, name: 'same' }]);
        assert.equal((await commit('mongo', recreated)).code, 'SCHEMA_CHANGED');
        const writer = new MongoClient(process.env[envNames[2]]!, { directConnection: true }); await writer.connect();
        try { await assert.rejects(writer.db('test').collection('hidden').insertOne({ x: 1 })); await assert.rejects(writer.db('test').collection('items').drop()); } finally { await writer.close(); }
        const missing = await call('mongodb_prepare_write', { sourceId: 'mongo', ...input, key: { _id: 'missing' } }); assert.equal(missing.error?.code, 'TARGET_NOT_FOUND');
      });
      await t.test('controlled writes through SSH preserve previews, commits and duplicate protection for all engines', async () => {
        process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
        try {
          for (const source of sourceConfigs) {
            const port = source.engine === 'mysql' ? s.port : source.engine === 'redis' ? r.port : m.port;
            const fixture = await sshFixture({ port });
            let through: Awaited<ReturnType<typeof runtime>> | undefined;
            try {
              through = await runtime([{ ...source, ssh: fixture.config }]);
              const input = source.engine === 'mysql' ? { table: 'items', action: 'insert', key: { tenant: 7, id: 700 }, values: { name: 'through-ssh' } } :
                source.engine === 'redis' ? { key: 'tenant:ssh-fixture', action: 'create', value: 'through-ssh', ttl: { mode: 'clear' } } :
                  { collection: 'items', action: 'insert', key: { _id: 'ssh-fixture' }, values: { name: 'through-ssh' } };
              const id = await prepare(source.id, input, through.dispatcher);
              const result = await commit(source.id, id, through.dispatcher);
              assert.equal(result.state, 'success', JSON.stringify(result));
              assert.equal((await commit(source.id, id, through.dispatcher)).state, 'success');
              if (source.engine === 'mysql') {
                const rows = (await sql!.query('SELECT name FROM items WHERE tenant=7 AND id=700'))[0] as mysql.RowDataPacket[];
                assert.deepEqual(rows.map(row => row.name), ['through-ssh']);
              } else if (source.engine === 'redis') assert.equal(await redis!.get('tenant:ssh-fixture'), 'through-ssh');
              else assert.equal((await mongo!.db('test').collection('items').findOne({ _id: 'ssh-fixture' } as any))?.name, 'through-ssh');
              assert.ok(fixture.targets.length > 0); assert.ok(fixture.targets.every(info => info.destPort === port));
            } finally { await through?.operations.stop(); await fixture.close(); }
          }
        } finally { delete process.env.DB_MCP_SSH_FIXTURE; }
      });
      await t.test('lost replies after actual server execution stay unknown and never replay', async () => {
        for (const [engine, sourceIndex, targetPort] of [['mysql',0,s.port], ['redis',1,r.port], ['mongo',2,m.port]] as const) {
          const proxy = await lostReplyProxy(engine, targetPort); resources.push(proxy);
          const sources = sourceConfigs.map(v => ({ ...v }));
          if (engine === 'mongo') process.env[envNames[2]] = `mongodb://writer:${secret}@127.0.0.1:${proxy.port}/test?authSource=test&replicaSet=rs0`;
          else Object.assign(sources[sourceIndex], { port: proxy.port });
          const pf = await runtime(sources);
          const args = engine === 'mysql' ? { table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'lost-reply' } } :
            engine === 'redis' ? { key: 'tenant:lost', action: 'create', value: 'lost-reply', ttl: { mode: 'clear' } } :
            { collection: 'items', action: 'update', key: { _id: 'two' }, expectedVersion: 0, values: { name: 'lost-reply' } };
          const id = await prepare(engine, args, pf.dispatcher); const result = await commit(engine, id, pf.dispatcher);
          assert.equal(result.state, 'unknown_outcome', engine + ' ' + JSON.stringify(result));
          const dropped = proxy.count();
          assert.equal(dropped, engine === 'mongo' ? 2 : 1);
          assert.equal((await commit(engine, id, pf.dispatcher)).state, 'unknown_outcome'); assert.equal(proxy.count(), dropped);
          const again = await call(engine === 'mongo' ? 'mongodb_prepare_write' : engine + '_prepare_write', { sourceId: engine, ...args }, pf.dispatcher);
          assert.equal(again.error.code, 'WRITE_OUTCOME_UNKNOWN'); assert.equal(proxy.count(), dropped);
          if (engine === 'mysql') assert.equal(((await sql!.query('SELECT name FROM items WHERE tenant=1 AND id=2'))[0] as mysql.RowDataPacket[])[0].name, 'lost-reply');
          else if (engine === 'redis') assert.equal(await redis!.get('tenant:lost'), 'lost-reply');
          else assert.equal((await db.collection('items').findOne({ _id: 'two' } as BSON.Document))!.name, 'lost-reply');
          await pf.operations.stop();
          const recovered = await OperationJournal.open(pf.config.instance.journal!, pf.config.instance.name);
          assert.equal(recovered.get(id)?.state, 'unknown_outcome'); await recovered.close();
          process.env[envNames[2]] = `mongodb://writer:${secret}@127.0.0.1:${m.port}/test?authSource=test&replicaSet=rs0`;
        }
      });
      await t.test('lost database acknowledgements inside SSH remain unknown and are never replayed', async () => {
        process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
        const originalURI = process.env[envNames[2]];
        try {
          await sql!.query("INSERT INTO items(tenant,id,version,name) VALUES (8,800,0,'old')");
          await db.collection<{ _id: string; version: number; name: string }>('items').insertOne({ _id: 'ssh-lost', version: 0, name: 'old' });
          for (const [engine, sourceIndex, targetPort] of [['mysql',0,s.port], ['redis',1,r.port], ['mongo',2,m.port]] as const) {
            const proxy = await lostReplyProxy(engine, targetPort);
            const fixture = await sshFixture({ port: proxy.port });
            let through: Awaited<ReturnType<typeof runtime>> | undefined;
            try {
              const source = { ...sourceConfigs[sourceIndex], ssh: fixture.config };
              if (engine === 'mongo') process.env[envNames[2]] = originalURI!.replace(':' + m.port + '/', ':' + proxy.port + '/');
              else Object.assign(source, { port: proxy.port });
              through = await runtime([source]);
              const input = engine === 'mysql' ? { table: 'items', action: 'update', key: { tenant: 8, id: 800 }, expectedVersion: 0, values: { name: 'ssh-lost-reply' } } :
                engine === 'redis' ? { key: 'tenant:ssh-lost', action: 'create', value: 'ssh-lost-reply', ttl: { mode: 'clear' } } :
                  { collection: 'items', action: 'update', key: { _id: 'ssh-lost' }, expectedVersion: 0, values: { name: 'ssh-lost-reply' } };
              const id = await prepare(engine, input, through.dispatcher);
              assert.equal((await commit(engine, id, through.dispatcher)).state, 'unknown_outcome');
              const dropped = proxy.count(); assert.ok(dropped > 0);
              assert.equal((await commit(engine, id, through.dispatcher)).state, 'unknown_outcome');
              assert.equal(proxy.count(), dropped);
              if (engine === 'mysql') assert.equal(((await sql!.query('SELECT name FROM items WHERE tenant=8 AND id=800'))[0] as mysql.RowDataPacket[])[0].name, 'ssh-lost-reply');
              else if (engine === 'redis') assert.equal(await redis!.get('tenant:ssh-lost'), 'ssh-lost-reply');
              else assert.equal((await db.collection<{ _id: string; name: string }>('items').findOne({ _id: 'ssh-lost' }))?.name, 'ssh-lost-reply');
            } finally { await through?.operations.stop(); await fixture.close(); await proxy.close(); process.env[envNames[2]] = originalURI; }
          }
        } finally { delete process.env.DB_MCP_SSH_FIXTURE; process.env[envNames[2]] = originalURI; }
      });
      await t.test('real credential rotation rejects old new-connections and explicitly closes existing Redis identity', async () => {
        const rotated = 'test_' + randomUUID().replaceAll('-', '');
        const names = ['DB_MCP_ROTATE_MYSQL','DB_MCP_ROTATE_REDIS','DB_MCP_ROTATE_MONGO'];
        const prior = names.map(n => process.env[n]);
        const registries: SourceRegistry[] = [];
        await sql!.query("CREATE USER 'rotator'@'%' IDENTIFIED BY ?", [secret]); await sql!.query("GRANT SELECT ON test.items TO 'rotator'@'%'");
        await redis!.sendCommand(['ACL','SETUSER','rotator','on','>' + secret,'~tenant:*','-@all','+ping','+type','+getrange']);
        await db.command({ createRole: 'mcp_rotate_reader', privileges: [{ resource: { db: 'test', collection: 'items' }, actions: ['find'] }], roles: [] });
        await db.command({ createUser: 'rotator', pwd: secret, roles: ['mcp_rotate_reader'] });
        await redis!.set('tenant:rotate', 'known-value');
        const uri = (password: string) => `mongodb://rotator:${password}@127.0.0.1:${m.port}/test?authSource=test&replicaSet=rs0`;
        names.forEach((name, i) => { process.env[name] = i === 2 ? uri(secret) : secret; });
        const config = parseV2Config({ version: 2, instance: { name: 'rotation', transport: 'stdio', environment: 'test', tier: 'read_only', budgets: { maxConnections: 12 } }, sources: [
          { ...sourceConfigs[0], username: 'rotator', passwordRef: 'env:' + names[0], tls: { mode: 'disabled' }, access: { tier: 'read_only', tables: ['items'], columns: { items: ['tenant','id','version','name'] } } },
          { ...sourceConfigs[1], username: 'rotator', passwordRef: 'env:' + names[1], tls: { mode: 'disabled' }, access: { tier: 'read_only', keyPrefixes: ['tenant:'] } },
          { ...sourceConfigs[2], connectionStringRef: 'env:' + names[2], tls: { mode: 'disabled' }, access: { tier: 'read_only', collections: ['items'], fields: { items: ['_id','version','name'] } } },
        ] });
        const open = async () => { const registry = new SourceRegistry(config, createAdapterFactory()); registries.push(registry); await registry.initialize(); return registry; };
        try {
          const old = await open(); const dispatcher = new Dispatcher(old);
          await sql!.query("ALTER USER 'rotator'@'%' IDENTIFIED BY ?", [rotated]);
          await redis!.sendCommand(['ACL','SETUSER','rotator','resetpass','>' + rotated]);
          await db.command({ updateUser: 'rotator', pwd: rotated });
          assert.equal((await dispatcher.call('mysql_select', { sourceId: 'mysql', table: 'items', limit: 1 })).isError, true);
          // Changing a password does NOT revoke this already authenticated Redis connection.
          assert.equal((await dispatcher.call('redis_get', { sourceId: 'redis', key: 'tenant:rotate' })).isError, undefined);
          await old.close(); assert.equal((await dispatcher.call('redis_get', { sourceId: 'redis', key: 'tenant:rotate' })).isError, true);
          await assert.rejects(open()); // old secret is not silently replaced or retried
          names.forEach((name, i) => { process.env[name] = i === 2 ? uri(rotated) : rotated; });
          const fresh = new Dispatcher(await open());
          for (const [tool, args] of [['mysql_select',{ sourceId:'mysql',table:'items',limit:1 }], ['redis_get',{sourceId:'redis',key:'tenant:rotate'}], ['mongodb_find',{sourceId:'mongo',collection:'items',limit:1}]] as const) {
            assert.equal((await fresh.call(tool, args)).isError, undefined);
          }
        } finally {
          await Promise.allSettled(registries.map(v => v.close())); names.forEach((n,i) => { if (prior[i] === undefined) delete process.env[n]; else process.env[n] = prior[i]; });
        }
      });
      await t.test('real stdio write protocol binds only operation ID and returns persisted status without secrets', async () => {
        const protocolDir = path.join(dir, 'protocol'); await mkdir(protocolDir, { mode: 0o700 });
        const config = { ...f.config, instance: { ...f.config.instance, journal: { ...f.config.instance.journal, directory: protocolDir } } };
        const filename = path.join(dir, 'protocol.json'); await writeFile(filename, JSON.stringify(config));
        let stderr = '';
        const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.js'), '--config', filename], env: Object.fromEntries(envNames.map(n => [n, process.env[n]!])), stderr: 'pipe' });
        transport.stderr?.on('data', value => { stderr += value; });
        const client = new Client({ name: 'write-test', version: '1' });
        try {
          await client.connect(transport); const tools = (await client.listTools()).tools; assert.ok(tools.some(t => t.name === 'commit_write' && !t.annotations?.readOnlyHint));
          const preview = await client.callTool({ name: 'redis_prepare_write', arguments: { sourceId: 'redis', key: 'tenant:protocol', action: 'create', value: 'hello', ttl: { mode: 'clear' } } });
          const operationId = JSON.parse((preview.content as Array<{ text: string }>)[0].text).operationId; assert.ok(operationId);
          const result = await client.callTool({ name: 'commit_write', arguments: { sourceId: 'redis', operationId } }); assert.equal(JSON.parse((result.content as Array<{ text: string }>)[0].text).state, 'success');
          assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!stderr.includes(secret));
        } finally { await client.close(); await transport.close(); }
      });
    } finally {
      for (const resource of resources.reverse()) await resource.close().catch(() => {});
      await sql?.end().catch(() => {}); if (redis?.isOpen) await redis.disconnect().catch(() => {}); await mongo?.close().catch(() => {});
      await Promise.allSettled(containers.map(id => docker(['rm', '-f', '-v', id])));
      envNames.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
      await rm(dir, { recursive: true, force: true });
    }
  });
