import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, chmod, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection as tcpConnect } from 'node:net';
import { createServer as tlsServer } from 'node:tls';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { BSON, MongoClient, type ObjectId } from 'mongodb';
import { loadV2Config, parseV2Config, type V2Config } from '../config/v2.js';
import { createAdapterFactory, createReadAdapter } from '../runtime/adapters.js';
import { SourceRegistry } from '../runtime/sources.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { definitions } from '../runtime/tool-catalog.js';
import { sshFixture } from './helpers/ssh.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function docker(args: string[]): Promise<string> {
  try { return (await exec('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? '').replace(/test_[0-9a-f]{32}/g, '[REDACTED_SECRET]');
    throw new Error('Isolated Docker test operation failed: ' + args[0] + ' ' + detail);
  }
}
async function until<T>(action: () => Promise<T>, attempts = 120): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await action(); } catch { await pause(500); }
  }
  throw new Error('Isolated test database did not become ready');
}

test('isolated real databases: TLS, native read-only grants, scopes, bounded data and certificate failures',
  { skip: process.env.DB_MCP_DOCKER_TESTS !== '1', timeout: 360000 }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-integration-'));
    const containers: string[] = [];
    const engineContainers = new Map<string, string>();
    const secret = 'test_' + randomUUID().replaceAll('-', '');
    const envNames = ['DB_MCP_TEST_MYSQL_PASSWORD', 'DB_MCP_TEST_REDIS_PASSWORD', 'DB_MCP_TEST_MONGO_URI', 'DB_MCP_TEST_MONGO_NESTED_URI', 'DB_MCP_TEST_MONGO_APP_RO_URI', 'DB_MCP_TEST_MONGO_PAGE_URI'];
    const previous = envNames.map(name => process.env[name]);
    let registry: SourceRegistry | undefined;
    let mysqlAdmin: mysql.Connection | undefined;
    let redisAdmin: ReturnType<typeof createClient> | undefined;
    let mongoAdmin: MongoClient | undefined;
    const cert = async (name: string, san: string, days: string) => {
      const key = path.join(dir, 'server.key');
      await writeFile(path.join(dir, name + '.ext'), 'subjectAltName=' + san + '\nextendedKeyUsage=serverAuth\n');
      await exec('openssl', ['req', '-new', '-key', key, '-subj', '/CN=db-mcp-test', '-out', path.join(dir, name + '.csr')]);
      await exec('openssl', ['x509', '-req', '-in', path.join(dir, name + '.csr'), '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'),
        '-CAcreateserial', '-days', days, '-extfile', path.join(dir, name + '.ext'), '-out', path.join(dir, name + '.pem')]);
    };
    const installCert = async (name: string) => {
      await copyFile(path.join(dir, name + '.pem'), path.join(dir, 'server.pem'));
      await writeFile(path.join(dir, 'server-combined.pem'), Buffer.concat([await readFile(path.join(dir, 'server.pem')), await readFile(path.join(dir, 'server.key'))]));
      await chmod(path.join(dir, 'server-combined.pem'), 0o644); // disposable certificate, private temp directory
    };
    try {
      await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=db-mcp-test-ca',
        '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.pem')]);
      await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=db-mcp-untrusted-ca',
        '-keyout', path.join(dir, 'bad-ca.key'), '-out', path.join(dir, 'bad-ca.pem')]);
      await exec('openssl', ['genrsa', '-out', path.join(dir, 'server.key'), '2048']);
      await chmod(path.join(dir, 'server.key'), 0o644);
      await cert('good', 'DNS:localhost', '2');
      await cert('wrong', 'DNS:wrong.example,IP:127.0.0.2', '2');
      await cert('expired', 'DNS:localhost', '0');
      await installCert('good');
      await chmod(dir, 0o755); // allow the disposable database UID to traverse its certificate-only bind mount
      const start = async (engine: string, port: number, extra: string[]) => {
        const name = 'db-mcp-test-' + engine + '-' + randomUUID().slice(0, 8);
        const id = await docker(['run', '-d', '--name', name, '--label', 'db-mcp.isolated-test=true', '-p', '127.0.0.1::' + port,
          '--mount', 'type=bind,src=' + dir + ',dst=/tls,readonly', ...extra]);
        containers.push(id);
        engineContainers.set(engine, id);
        const mapping = await docker(['port', id, String(port)]);
        return Number(mapping.split(':').at(-1));
      };
      const started = await Promise.allSettled([
        start('mysql', 3306, ['-e', 'MYSQL_ROOT_PASSWORD=' + secret, 'mysql:8.4.8', '--ssl-ca=/tls/ca.pem', '--ssl-cert=/tls/server.pem', '--ssl-key=/tls/server.key', '--require-secure-transport=ON']),
        start('redis', 6379, ['redis:7.4.7', 'redis-server', '--port', '0', '--tls-port', '6379', '--tls-cert-file', '/tls/server.pem', '--tls-key-file', '/tls/server.key', '--tls-ca-cert-file', '/tls/ca.pem', '--tls-auth-clients', 'no', '--requirepass', secret, '--save', '', '--appendonly', 'no']),
        start('mongo', 27017, ['-e', 'MONGO_INITDB_ROOT_USERNAME=test_admin', '-e', 'MONGO_INITDB_ROOT_PASSWORD=' + secret, 'mongo:7.0.31', '--tlsMode=requireTLS', '--tlsCertificateKeyFile=/tls/server-combined.pem', '--tlsCAFile=/tls/ca.pem', '--tlsAllowConnectionsWithoutCertificates']),
      ]);
      if (started.some(result => result.status === 'rejected')) throw new Error('Isolated database setup failed');
      const [mysqlPort, redisPort, mongoPort] = started.map(result => (result as PromiseFulfilledResult<number>).value);
      const ca = await readFile(path.join(dir, 'ca.pem'));
      mysqlAdmin = await until(async () => mysql.createConnection({ host: 'localhost', port: mysqlPort, user: 'root', password: secret, ssl: { ca, rejectUnauthorized: true, verifyIdentity: true }, connectTimeout: 1000 }));
      redisAdmin = await until(async () => {
        const client = createClient({ password: secret, socket: { host: 'localhost', port: redisPort, tls: true, ca, rejectUnauthorized: true, reconnectStrategy: false, connectTimeout: 1000 } });
        client.on('error', () => {});
        try { await client.connect(); return client; } catch (error) { if (client.isOpen) await client.disconnect(); throw error; }
      });
      mongoAdmin = await until(async () => {
        const client = new MongoClient(`mongodb://test_admin:${secret}@localhost:${mongoPort}/admin`, { tls: true, ca, directConnection: true, serverSelectionTimeoutMS: 1000 });
        try { await client.connect(); return client; } catch (error) { await client.close(); throw error; }
      });
      await mysqlAdmin.query('CREATE DATABASE test');
      await mysqlAdmin.query('CREATE TABLE test.reports (id INT PRIMARY KEY, name MEDIUMTEXT, password TEXT)');
      await mysqlAdmin.query('CREATE TABLE test.hidden (id INT)');
      await mysqlAdmin.execute('INSERT INTO test.reports VALUES (1, ?, ?), (2, ?, ?), (99, ?, ?)', ['hello', 'hidden-value', '世界', 'hidden-value', '中'.repeat(20000), 'hidden-value']);
      await mysqlAdmin.query("CREATE USER 'reader'@'%' IDENTIFIED BY ?", [secret]);
      await mysqlAdmin.query("GRANT SELECT ON test.reports TO 'reader'@'%'");
      await redisAdmin.set('tenant1:one', 'hello');
      await redisAdmin.set('tenant1:big', '中'.repeat(400000));
      await redisAdmin.hSet('tenant1:hash', 'field', 'value');
      await redisAdmin.set('tenant2:hidden', 'hidden-value');
      await redisAdmin.sendCommand(['ACL', 'SETUSER', 'reader', 'on', '>' + secret, '~tenant1:*', '-@all', '+ping', '+getrange', '+type', '+memory|usage', '+scan']);
      const db = mongoAdmin.db('test');
      await db.collection('reports').insertMany([{ id: 1, name: 'hello', password: 'hidden-value' }, { id: 2, name: '世界' }, { id: 99, name: '中'.repeat(20000) }]);
      await db.collection('hidden').insertOne({ secret: 'hidden-value' });
      await db.command({ createRole: 'mcp_read', privileges: [{ resource: { db: 'test', collection: 'reports' }, actions: ['find'] }], roles: [] });
      await db.command({ createUser: 'reader', pwd: secret, roles: ['mcp_read'] });
      await db.collection<{ _id: { tenant: number; private: string }; profile: { name: string; email: string }; password: string }>('nested_reports')
        .insertOne({ _id: { tenant: 7, private: 'hidden-id' }, profile: { name: 'hello', email: 'hidden-email' }, password: 'hidden-value' });
      await db.command({ createRole: 'mcp_nested_read', privileges: [{ resource: { db: 'test', collection: 'nested_reports' }, actions: ['find'] }], roles: [] });
      await db.command({ createUser: 'nested_reader', pwd: secret, roles: ['mcp_nested_read'] });
      process.env[envNames[0]] = secret; process.env[envNames[1]] = secret;
      process.env[envNames[2]] = `mongodb://reader:${secret}@localhost:${mongoPort}/test?authSource=test`;
      process.env[envNames[3]] = `mongodb://nested_reader:${secret}@localhost:${mongoPort}/test?authSource=test`;
      const base = { required: true, tls: { mode: 'verify_identity', caFile: path.join(dir, 'ca.pem') }, budgets: { maxRows: 2, maxItemBytes: 2048, connectTimeoutMs: 2000 } };
      const config = parseV2Config({ version: 2, instance: { name: 'integration', transport: 'stdio', environment: 'test', tier: 'read_only' }, sources: [
        { ...base, id: 'mysql', engine: 'mysql', host: 'localhost', port: mysqlPort, database: 'test', username: 'reader', passwordRef: 'env:' + envNames[0], access: { tier: 'read_only', tables: ['reports'], columns: { reports: ['id', 'name'] } } },
        { ...base, id: 'redis', engine: 'redis', host: 'localhost', port: redisPort, username: 'reader', passwordRef: 'env:' + envNames[1], access: { tier: 'read_only', keyPrefixes: ['tenant1:'], allowKeyspaceScan: true } },
        { ...base, id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:' + envNames[2], access: { tier: 'read_only', collections: ['reports'], fields: { reports: ['id', 'name'] } } },
      ] });
      await t.test('stdio MCP shares connection settings, uses default databases and blocks excluded databases', async () => {
        for (const name of ['multi-reports', 'multi-private', 'multi-ungranted']) {
          const schema = mysql.escapeId(name);
          await mysqlAdmin!.query('CREATE DATABASE ' + schema);
          await mysqlAdmin!.query('CREATE TABLE ' + schema + '.reports (id INT PRIMARY KEY, name TEXT)');
          await mysqlAdmin!.execute('INSERT INTO ' + schema + '.reports VALUES (1, ?)', [name]);
          if (name !== 'multi-ungranted') await mysqlAdmin!.query("GRANT SELECT ON " + schema + ".reports TO 'reader'@'%'");
          await mongoAdmin!.db(name).collection('reports').insertOne({ id: 1, name });
        }
        await db.command({ grantRolesToUser: 'reader', roles: [
          { role: 'read', db: 'multi-reports' }, { role: 'read', db: 'multi-private' },
        ] });
        for (const index of [1, 2]) {
          await redisAdmin!.select(index);
          await redisAdmin!.set('tenant1:one', 'database-' + index);
        }
        await redisAdmin!.select(0);
        await redisAdmin!.sendCommand(['ACL', 'SETUSER', 'reader', '+select']);

        const filename = path.join(dir, 'multi.json');
        const sources = config.sources.map(source => ({
          ...source, databaseScope: 'visible', ...(source.engine === 'redis' ?
            { databases: [1, 2], excludeDatabases: [2] } : { excludeDatabases: ['multi-private'] }),
        }));
        await writeFile(filename, JSON.stringify({ ...config, sources }), { mode: 0o600 });
        const transport = new StdioClientTransport({
          command: process.execPath, args: [path.resolve('dist/index.js'), '--config', filename],
          env: Object.fromEntries(envNames.slice(0, 3).map(name => [name, process.env[name]!])), stderr: 'pipe',
        });
        transport.stderr?.on('data', () => {});
        const client = new Client({ name: 'db-mcp-multi-database-test', version: '1.0.0' });
        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          const databasesTool = tools.find(tool => tool.name === 'list_databases');
          const sourceSchema = databasesTool?.inputSchema.properties?.sourceId as { enum?: string[] } | undefined;
          assert.deepEqual(sourceSchema?.enum, ['mysql', 'redis', 'mongo']);
          assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
          const call = async (name: string, args: Record<string, unknown>, denied?: 'SCOPE_DENIED' | 'INVALID_ARGUMENT') => {
            const result = await client.callTool({ name, arguments: args });
            assert.equal(result.isError, denied ? true : undefined);
            const serialized = (result.content as Array<{ text: string }>)[0].text;
            assert.ok(!serialized.includes(secret) && !serialized.includes('multi-private') && !serialized.includes('multi-ungranted'));
            const body = JSON.parse(serialized);
            if (denied) assert.equal(body.error.code, denied);
            return body;
          };
          const discovered = await call('list_sources', {});
          assert.deepEqual(discovered.sources.map((entry: { defaultDatabase: string | number }) => entry.defaultDatabase), ['test', 0, 'test']);
          for (const sourceId of ['mysql', 'mongo', 'redis']) {
            const names: Array<number | string> = [];
            let cursor: string | undefined;
            do {
              const page = await call('list_databases', { sourceId, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
              names.push(...page.rows.map((row: { database: string | number }) => row.database));
              cursor = page.nextCursor;
              assert.ok(names.length < 20);
            } while (cursor);
            if (sourceId === 'redis') assert.deepEqual(names, [0, 1]);
            else assert.ok(names.includes('test') && names.includes('multi-reports'));
          }
          const mysqlArgs = { sourceId: 'mysql', table: 'reports', columns: ['name'], where: { id: 1 } };
          const mongoArgs = { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } };
          const redisArgs = { sourceId: 'redis', key: 'tenant1:one' };
          for (const [name, args] of [['mysql_select', mysqlArgs], ['mongodb_find_one', mongoArgs]] as const) {
            assert.equal((await call(name, args)).rows[0].name, 'hello');
            assert.equal((await call(name, { ...args, database: 'multi-reports' })).rows[0].name, 'multi-reports');
            const denied = await call(name, { ...args, database: 'MULTI-PRIVATE' }, 'SCOPE_DENIED');
            assert.equal(denied.error.details.reason, 'database_denied');
            await call(name, { ...args, database: 'multi-ungranted' }, 'SCOPE_DENIED');
          }
          const values = await Promise.all([{}, { database: 1 }, {}, { database: 1 }].map(
            options => call('redis_get', { ...redisArgs, ...options })));
          assert.deepEqual(values.map(value => Buffer.from(value.rows[0].value, 'base64').toString()),
            ['hello', 'database-1', 'hello', 'database-1']);
          for (const database of [2, 3]) await call('redis_get', { ...redisArgs, database }, 'SCOPE_DENIED');

          const page = await call('list_databases', { sourceId: 'mongo', limit: 1 });
          assert.ok(page.nextCursor);
          await call('list_databases', { sourceId: 'mysql', limit: 1, cursor: page.nextCursor }, 'INVALID_ARGUMENT');
          const scan = { sourceId: 'redis', prefix: 'tenant1:', limit: 1 };
          const keys = await call('redis_keys', scan);
          assert.ok(keys.nextCursor);
          await call('redis_keys', { ...scan, database: 1, cursor: keys.nextCursor }, 'INVALID_ARGUMENT');
        } finally { await client.close(); await transport.close(); }
      });
      await t.test('one private config file authenticates all three read-only sources with inline credentials', async () => {
        const privateDir = await mkdtemp(path.join(tmpdir(), 'db-mcp-inline-integration-'));
        let local: SourceRegistry | undefined;
        try {
          const sources = config.sources.map(source => {
            if (source.engine === 'mongodb') {
              const { connectionStringRef, ...settings } = source;
              return { ...settings, connectionString: process.env[envNames[2]] };
            }
            const { passwordRef, ...settings } = source;
            return { ...settings, password: secret };
          });
          const filename = path.join(privateDir, 'config.json');
          await writeFile(filename, JSON.stringify({ ...config, sources }), { mode: 0o600 });
          local = new SourceRegistry(await loadV2Config(filename), createAdapterFactory());
          await local.initialize();
          const dispatcher = new Dispatcher(local);
          for (const [name, args] of [
            ['mysql_select', { sourceId: 'mysql', table: 'reports', where: { id: 1 } }],
            ['redis_get', { sourceId: 'redis', key: 'tenant1:one' }],
            ['mongodb_find_one', { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } }],
          ] as const) {
            const result = await dispatcher.call(name, args);
            assert.equal(result.isError, undefined);
            assert.equal(JSON.parse(result.content[0].text).rows.length, 1);
            assert.ok(!JSON.stringify(result).includes(secret));
          }
        } finally {
          try { await local?.close(); }
          finally { await rm(privateDir, { recursive: true, force: true }); }
        }
      });
      // Probe separately so initialization failures identify a driver without printing credentials.
      for (const source of config.sources) {
        const adapter = await createReadAdapter(source, config);
        try { await adapter.connect(); }
        catch (error) { throw new Error('Isolated driver initialization failed: ' + source.engine + ' ' + String(error).replaceAll(secret, '[REDACTED_SECRET]')); }
        finally { await adapter.close(); }
      }
      registry = new SourceRegistry(config, createAdapterFactory()); await registry.initialize();
      const dispatcher = new Dispatcher(registry);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await dispatcher.call(name, args);
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
        assert.ok(!JSON.stringify(result).includes(secret));
        return JSON.parse(result.content[0].text);
      };
      await t.test('real reads are scoped, parameterized, projected and bounded', async () => {
        const selected = await call('mysql_select', { sourceId: 'mysql', table: 'reports', orderBy: [{ field: 'id', direction: 'asc' }] });
        assert.deepEqual(selected.rows, [{ id: 1, name: 'hello' }, { id: 2, name: '世界' }]);
        assert.equal(selected.truncated, true);
        assert.deepEqual((await call('mysql_select', { sourceId: 'mysql', table: 'reports', where: { name: "' OR 1=1 --" } })).rows, []);
        assert.equal((await call('mysql_select', { sourceId: 'mysql', table: 'reports', where: { id: 99 } })).reason, 'item_bytes');
        assert.ok(!(await call('mysql_describe_table', { sourceId: 'mysql', table: 'reports' })).rows.some((r: any) => r.COLUMN_NAME === 'password'));
        assert.deepEqual((await call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } })).rows, [{ id: { $numberInt: '1' }, name: 'hello' }]);
        assert.deepEqual(await call('mongodb_find_one', { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } }), {
          rows: [{ id: { $numberInt: '1' }, name: 'hello' }], truncated: false,
        });
        assert.deepEqual(await call('mongodb_find_one', { sourceId: 'mongo', collection: 'reports', filter: { id: 99 } }), {
          rows: [], truncated: true, reason: 'item_bytes',
        });
        assert.equal((await call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { id: 99 } })).reason, 'item_bytes');
        const fragment = (await call('redis_get', { sourceId: 'redis', key: 'tenant1:big' })).rows[0];
        assert.ok(fragment.bytes <= 256); assert.equal(fragment.complete, false);
        assert.equal(fragment.hasMore, true);
        assert.equal(fragment.nextOffset, fragment.bytes);
        const hash = { sourceId: 'redis', key: 'tenant1:hash' };
        const wrongType = await dispatcher.call('redis_get', hash);
        assert.equal(wrongType.isError, true);
        assert.equal(JSON.parse(wrongType.content[0].text).error.code, 'REDIS_WRONG_TYPE');
        assert.equal((await call('redis_type', hash)).rows[0].type, 'hash');
        const keys = await call('redis_keys', { sourceId: 'redis', prefix: 'tenant1:' });
        assert.ok(keys.rows.every((r: any) => r.key.startsWith('tenant1:')));
        for (const [name, args] of [
          ['mysql_select', { sourceId: 'mysql', table: 'hidden' }], ['mysql_select', { sourceId: 'mysql', table: 'reports', columns: ['password'] }],
          ['mongodb_find', { sourceId: 'mongo', collection: 'hidden' }], ['mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { name: { $ne: 'x' } } }],
          ['redis_get', { sourceId: 'redis', key: 'tenant2:hidden' }], ['redis_keys', { sourceId: 'redis', prefix: '' }],
          ['redis_keys', { sourceId: 'redis', prefix: 'tenant1:', pattern: '*' }], ['mysql_select', { sourceId: 'redis', table: 'reports' }],
        ] as const) assert.equal((await dispatcher.call(name, args)).isError, true);
      });
      await t.test('Redis fragments distinguish exact lengths, continuation and end of value', async () => {
        const key = 'tenant1:fragment', emptyKey = 'tenant1:fragment-empty', missingKey = 'tenant1:fragment-missing';
        const value = Buffer.from([0, 255, 195, 148, 128]);
        await redisAdmin!.set(key, value);
        await redisAdmin!.set(emptyKey, '');
        const sourceId = 'redis';
        const range = async (offset: number, bytes: number, target = key) =>
          (await call('redis_get_range', { sourceId, key: target, offset, bytes })).rows[0];
        try {
          const exact = await range(0, value.length);
          assert.equal(exact.complete, true);
          assert.equal(exact.hasMore, false);
          assert.equal(exact.nextOffset, undefined);
          assert.deepEqual(Buffer.from(exact.value, 'base64'), value);

          const first = await range(0, 2);
          assert.equal(first.complete, false);
          assert.equal(first.hasMore, true);
          assert.equal(first.bytes, 2);
          assert.equal(first.nextOffset, 2);
          const last = await range(first.nextOffset, 3);
          assert.equal(last.complete, false);
          assert.equal(last.hasMore, false);
          assert.equal(last.nextOffset, undefined);
          assert.equal(last.bytes, 3);
          assert.deepEqual(Buffer.concat([first, last].map(row => Buffer.from(row.value, 'base64'))), value);

          for (const target of [emptyKey, missingKey]) {
            const empty = await range(0, 1, target);
            assert.equal(empty.complete, true);
            assert.equal(empty.hasMore, false);
            assert.equal(empty.nextOffset, undefined);
            assert.equal(empty.bytes, 0);
            assert.equal(empty.value, '');
          }
          const beyond = await range(Number.MAX_SAFE_INTEGER, 1);
          assert.equal(beyond.complete, false);
          assert.equal(beyond.hasMore, false);
          assert.equal(beyond.nextOffset, undefined);
          assert.equal(beyond.bytes, 0);
        } finally { await redisAdmin!.del([key, emptyKey]); }
      });
      await t.test('all three drivers read through real SSH tunnels while retaining TLS and policy boundaries', async () => {
        process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
        try {
          for (const source of config.sources) {
            const port = source.engine === 'mysql' ? mysqlPort : source.engine === 'redis' ? redisPort : mongoPort;
            const fixture = await sshFixture({ host: 'localhost', port });
            const tunneled = parseV2Config({ ...config, sources: [{ ...source, ssh: fixture.config }] });
            const target = new SourceRegistry(tunneled, createAdapterFactory());
            try {
              await target.initialize();
              const through = new Dispatcher(target);
              const [name, args] = source.engine === 'mysql' ? ['mysql_select', { sourceId: source.id, table: 'reports', where: { id: 1 } }] :
                source.engine === 'redis' ? ['redis_get', { sourceId: source.id, key: 'tenant1:one' }] :
                  ['mongodb_find', { sourceId: source.id, collection: 'reports', filter: { id: 1 } }];
              const result = await through.call(name as string, args);
              assert.equal(result.isError, undefined, JSON.stringify(result));
              const data = JSON.parse(result.content[0].text);
              if (source.engine === 'redis') assert.equal(Buffer.from(data.rows[0].value, 'base64').toString(), 'hello');
              else assert.deepEqual(data.rows, [{ id: source.engine === 'mongodb' ? { $numberInt: '1' } : 1, name: 'hello' }]);
              assert.ok(fixture.targets.length > 0); assert.ok(fixture.targets.every(info => info.destIP === 'localhost' && info.destPort === port));
              const write = await through.call(source.engine + '_prepare_write', { sourceId: source.id });
              assert.equal(write.isError, true);
              // A trusted CA still must not authorize another database identity,
              // even though both identities use the very same loopback tunnel.
              const previousURI = process.env[envNames[2]];
              if (source.engine === 'mongodb') process.env[envNames[2]] = previousURI!.replace('localhost:', 'wrong.internal.example:');
              try {
                const mismatch = parseV2Config({ ...config, sources: [{ ...source,
                  ...(source.engine !== 'mongodb' ? { host: 'wrong.internal.example' } : {}), ssh: fixture.config }] });
                const adapter = await createReadAdapter(mismatch.sources[0], mismatch);
                try {
                  await assert.rejects(adapter.connect(), error => {
                    assert.ok(/certificate|altnames|SSL_HANDSHAKE|CONNECTION_LOST/i.test(String(error)), String(error).replaceAll(secret, '[REDACTED_SECRET]'));
                    return true;
                  });
                } finally { await adapter.close(); }
                if (source.engine === 'mongodb') {
                  const optional = parseV2Config({ ...mismatch, sources: [{ ...mismatch.sources[0], required: false }] });
                  const invalid = new SourceRegistry(optional, createAdapterFactory());
                  try {
                    await invalid.initialize();
                    await until(async () => { assert.equal(invalid.list()[0].status, 'unavailable'); }, 8);
                    assert.equal(invalid.list()[0].errorCode, 'DATABASE_TLS_INVALID');
                  } finally { await invalid.close(); }
                }
              } finally { process.env[envNames[2]] = previousURI; }
              const old = target.get(source.id).connection;
              assert.ok(old);
              fixture.disconnect();
              await until(async () => { assert.equal(old.signal.aborted, true); });
              await until(async () => {
                assert.equal(target.list()[0].status, 'ready');
                assert.notEqual(target.get(source.id).connection, old);
              });
              const recovered = await through.call(name as string, args);
              assert.equal(recovered.isError, undefined, JSON.stringify(recovered));
              assert.deepEqual(JSON.parse(recovered.content[0].text).rows, data.rows);
            } finally { await target.close(); await fixture.close(); }
          }
        } finally { delete process.env.DB_MCP_SSH_FIXTURE; }
      });
      await t.test('SSH MySQL and MongoDB sources detect backend loss without losing the jump host', { timeout: 35000 }, async () => {
        process.env.DB_MCP_SSH_FIXTURE = 'fixture-ssh-password';
        try {
          for (const source of config.sources.filter(source => source.engine !== 'redis')) {
            const fixture = await sshFixture({ host: 'localhost', port: source.engine === 'mysql' ? mysqlPort : mongoPort });
            const tunneled = parseV2Config({ ...config, sources: [{ ...source, ssh: fixture.config,
              ...(source.engine === 'mysql' ? { access: { readScope: 'database' } } : {}) }] });
            const target = new SourceRegistry(tunneled, createAdapterFactory());
            const through = new Dispatcher(target);
            const read = () => source.engine === 'mysql'
              ? through.call('mysql_select', { sourceId: source.id, table: 'reports', where: { id: 1 } })
              : through.call('mongodb_find', { sourceId: source.id, collection: 'reports', filter: { id: 1 } });
            try {
              await target.initialize();
              const old = target.get(source.id).connection!;
              assert.equal((await read()).isError, undefined);
              if (source.engine === 'mysql') {
                const badQuery = await through.call('mysql_select', { sourceId: source.id, table: 'missing_table' });
                assert.equal(badQuery.isError, true);
                assert.equal(target.get(source.id).connection, old);
              }
              fixture.setBackendOnline(false);
              assert.equal((await read()).isError, true);
              await until(async () => {
                assert.equal(target.list()[0].status, 'reconnecting');
                assert.equal(old.signal.aborted, true);
              }, 28);
              fixture.setBackendOnline(true);
              await until(async () => {
                assert.equal(target.list()[0].status, 'ready');
                assert.notEqual(target.get(source.id).connection, old);
              }, 12);
              assert.equal((await read()).isError, undefined);
            } finally { await target.close(); await fixture.close(); }
          }
        } finally { delete process.env.DB_MCP_SSH_FIXTURE; }
      });
      await t.test('database-native permissions independently reject writes and outside scope', async () => {
        const reader = await mysql.createConnection({ host: 'localhost', port: mysqlPort, user: 'reader', password: secret, database: 'test', ssl: { ca, rejectUnauthorized: true, verifyIdentity: true } });
        try {
          for (const sql of ["INSERT INTO reports VALUES (3,'bad','bad')", "UPDATE reports SET name='bad' WHERE id=1", 'DELETE FROM reports WHERE id=1', 'ALTER TABLE reports ADD bad INT', 'SELECT * FROM hidden']) {
            await assert.rejects(reader.query(sql), (error: any) => error.code === 'ER_TABLEACCESS_DENIED_ERROR');
          }
        } finally { await reader.end(); }
        const rr = createClient({ username: 'reader', password: secret, socket: { host: 'localhost', port: redisPort, tls: true, ca, reconnectStrategy: false } }); rr.on('error', () => {});
        await rr.connect();
        try {
          await assert.rejects(rr.set('tenant1:one', 'bad'), /NOPERM/);
          await assert.rejects(rr.getRange('tenant2:hidden', 0, 1), /NOPERM/);
          await assert.rejects(rr.flushDb(), /NOPERM/);
          const scanned = await rr.scan(0, { COUNT: 100 });
          assert.ok(scanned.keys.includes('tenant2:hidden')); // ACL prefix is not keyspace response isolation
        } finally { await rr.disconnect(); }
        const mr = new MongoClient(process.env[envNames[2]]!, { tls: true, ca, directConnection: true }); await mr.connect();
        try {
          await assert.rejects(mr.db('test').collection('reports').insertOne({ id: 3 }), (error: any) => error.code === 13);
          await assert.rejects(mr.db('test').collection('hidden').findOne({}), (error: any) => error.code === 13);
        } finally { await mr.close(); }
      });
      await t.test('application read-only mode denies writes even when the same native identities can perform CRUD', async () => {
        // Independent identities/fixtures keep the native read-only-grant assertions intact.
        await mysqlAdmin!.query('CREATE TABLE test.app_ro_reports (id INT PRIMARY KEY, name VARCHAR(128))');
        await mysqlAdmin!.query("CREATE USER 'app_writer'@'%' IDENTIFIED BY ?", [secret]);
        await mysqlAdmin!.query("GRANT SELECT, INSERT, UPDATE, DELETE ON test.app_ro_reports TO 'app_writer'@'%'");
        await redisAdmin!.sendCommand(['ACL', 'SETUSER', 'app_writer', 'on', '>' + secret, '~app_ro:*', '-@all', '+ping', '+get', '+getrange', '+type', '+set', '+del']);
        await db.createCollection('app_ro_reports');
        await db.command({ createRole: 'mcp_app_writer', privileges: [{ resource: { db: 'test', collection: 'app_ro_reports' }, actions: ['find', 'insert', 'update', 'remove'] }], roles: [] });
        await db.command({ createUser: 'app_writer', pwd: secret, roles: ['mcp_app_writer'] });
        process.env[envNames[4]] = `mongodb://app_writer:${secret}@localhost:${mongoPort}/test?authSource=test`;
        const controlSql = await mysql.createConnection({ host: 'localhost', port: mysqlPort, user: 'app_writer', password: secret, database: 'test', ssl: { ca, rejectUnauthorized: true, verifyIdentity: true } });
        const controlRedis = createClient({ username: 'app_writer', password: secret, disableClientInfo: true,
          socket: { host: 'localhost', port: redisPort, tls: true, ca, rejectUnauthorized: true, reconnectStrategy: false } });
        controlRedis.on('error', () => {});
        const controlMongo = new MongoClient(process.env[envNames[4]]!, { tls: true, ca, directConnection: true, retryReads: false, retryWrites: false });
        try {
          await controlRedis.connect(); await controlMongo.connect();
          await controlSql.execute('INSERT INTO app_ro_reports VALUES (?, ?), (?, ?)', [1, 'created', 2, 'temporary']);
          const [sqlChanged] = await controlSql.execute<mysql.ResultSetHeader>('UPDATE app_ro_reports SET name=? WHERE id=?', ['baseline', 1]);
          assert.equal(sqlChanged.affectedRows, 1);
          const [sqlDeleted] = await controlSql.execute<mysql.ResultSetHeader>('DELETE FROM app_ro_reports WHERE id=?', [2]);
          assert.equal(sqlDeleted.affectedRows, 1);
          await controlRedis.set('app_ro:one', 'created'); await controlRedis.set('app_ro:one', 'baseline');
          await controlRedis.set('app_ro:temporary', 'temporary'); assert.equal(await controlRedis.del('app_ro:temporary'), 1);
          const collection = controlMongo.db('test').collection<{ _id: string; name: string }>('app_ro_reports');
          await collection.insertMany([{ _id: 'one', name: 'created' }, { _id: 'temporary', name: 'temporary' }]);
          assert.equal((await collection.updateOne({ _id: 'one' }, { $set: { name: 'baseline' } })).modifiedCount, 1);
          assert.equal((await collection.deleteOne({ _id: 'temporary' })).deletedCount, 1);
          const assertNativeBaseline = async () => {
            const [rows] = await controlSql.query<mysql.RowDataPacket[]>('SELECT id,name FROM app_ro_reports ORDER BY id');
            assert.deepEqual(rows, [{ id: 1, name: 'baseline' }]);
            assert.equal(await controlRedis.get('app_ro:one'), 'baseline');
            assert.equal(await controlRedis.get('app_ro:temporary'), null);
            assert.deepEqual(await collection.find({}).sort({ _id: 1 }).toArray(), [{ _id: 'one', name: 'baseline' }]);
          };
          await assertNativeBaseline();
          for (const explicit of [false, true]) {
            const input = { version: 2, instance: { name: 'application-ro', transport: 'stdio', environment: 'test', tier: 'read_only' }, sources: [
              { ...base, id: 'mysql_ro', engine: 'mysql', host: 'localhost', port: mysqlPort, database: 'test', username: 'app_writer', passwordRef: 'env:' + envNames[0], access: { tier: 'read_only', tables: ['app_ro_reports'], columns: { app_ro_reports: ['id', 'name'] } } },
              { ...base, id: 'redis_ro', engine: 'redis', host: 'localhost', port: redisPort, username: 'app_writer', passwordRef: 'env:' + envNames[1], access: { tier: 'read_only', keyPrefixes: ['app_ro:'] } },
              { ...base, id: 'mongo_ro', engine: 'mongodb', database: 'test', connectionStringRef: 'env:' + envNames[4], access: { tier: 'read_only', collections: ['app_ro_reports'], fields: { app_ro_reports: ['_id', 'name'] } } },
            ] };
            if (!explicit) { Reflect.deleteProperty(input.instance, 'tier'); for (const source of input.sources) Reflect.deleteProperty(source.access, 'tier'); }
            const scoped = parseV2Config(input);
            assert.equal(scoped.instance.tier, 'read_only'); assert.ok(scoped.sources.every(source => source.access.tier === 'read_only'));
            const target = new SourceRegistry(scoped, createAdapterFactory());
            try {
              await target.initialize();
              const application = new Dispatcher(target);
              assert.ok(application.tools().every(tool => !definitions.find(definition => definition.name === tool.name)?.requiresWrite));
              for (const source of scoped.sources) assert.equal(target.get(source.id).connection?.adapter.writer, undefined);
              const selected = await application.call('mysql_select', { sourceId: 'mysql_ro', table: 'app_ro_reports' });
              assert.equal(selected.isError, undefined); assert.deepEqual(JSON.parse(selected.content[0].text).rows, [{ id: 1, name: 'baseline' }]);
              const found = await application.call('mongodb_find', { sourceId: 'mongo_ro', collection: 'app_ro_reports' });
              assert.equal(found.isError, undefined); assert.deepEqual(JSON.parse(found.content[0].text).rows, [{ _id: 'one', name: 'baseline' }]);
              const fetched = await application.call('redis_get', { sourceId: 'redis_ro', key: 'app_ro:one' });
              assert.equal(fetched.isError, undefined); assert.equal(Buffer.from(JSON.parse(fetched.content[0].text).rows[0].value, 'base64').toString(), 'baseline');
              const operationId = randomUUID();
              for (const [name, args] of [
                ['mysql_prepare_write', { sourceId: 'mysql_ro', table: 'app_ro_reports', action: 'update', key: { id: 1 }, expectedVersion: 0, values: { name: 'MCP-must-not-write' } }],
                ['mongodb_prepare_write', { sourceId: 'mongo_ro', collection: 'app_ro_reports', action: 'update', key: { _id: 'one' }, expectedVersion: 0, values: { name: 'MCP-must-not-write' } }],
                ['redis_prepare_write', { sourceId: 'redis_ro', key: 'app_ro:one', action: 'replace', value: 'MCP-must-not-write', expectedValue: 'baseline', expectedTtl: { mode: 'persistent' }, ttl: { mode: 'keep' } }],
                ...['mysql_ro', 'redis_ro', 'mongo_ro'].flatMap(sourceId => ['commit_write', 'operation_status'].map(name => [name, { sourceId, operationId }] as const)),
                ['mysql_query', { sourceId: 'mysql_ro', sql: "UPDATE app_ro_reports SET name='MCP-must-not-write' WHERE id=1" }],
                ['mysql_update', { sourceId: 'mysql_ro', table: 'app_ro_reports', data: { name: 'MCP-must-not-write' }, where: { id: 1 } }],
                ['mongodb_update_one', { sourceId: 'mongo_ro', collection: 'app_ro_reports', filter: { _id: 'one' }, update: { $set: { name: 'MCP-must-not-write' } } }],
                ['redis_set', { sourceId: 'redis_ro', key: 'app_ro:one', value: 'MCP-must-not-write' }],
                ['redis_eval', { sourceId: 'redis_ro', script: "return redis.call('SET',KEYS[1],ARGV[1])", keys: ['app_ro:one'], args: ['MCP-must-not-write'] }],
                ['unknown_write', { sourceId: 'mysql_ro' }],
              ] as ReadonlyArray<readonly [string, Record<string, unknown>]>) {
                const denied = await application.call(name, args);
                assert.equal(denied.isError, true, name); assert.equal(JSON.parse(denied.content[0].text).error.code, 'SCOPE_DENIED', name);
              }
              for (const [name, args, code] of [
                ['mysql_select', { sourceId: 'mysql_ro', table: 'app_ro_reports', sql: "UPDATE app_ro_reports SET name='MCP-must-not-write'" }, 'INVALID_ARGUMENT'],
                ['mongodb_find', { sourceId: 'mongo_ro', collection: 'app_ro_reports', filter: { $where: "this.name='MCP-must-not-write'" } }, 'SCOPE_DENIED'],
                ['redis_get', { sourceId: 'redis_ro', key: 'app_ro:one', script: "return redis.call('SET',KEYS[1],ARGV[1])" }, 'INVALID_ARGUMENT'],
              ] as const) {
                const denied = await application.call(name, args);
                assert.equal(denied.isError, true, name); assert.equal(JSON.parse(denied.content[0].text).error.code, code, name);
              }
              await assertNativeBaseline();
            } finally { await target.close(); }
          }
        } finally {
          await controlSql.end().catch(() => {});
          if (controlRedis.isOpen) await controlRedis.disconnect().catch(() => {});
          await controlMongo.close().catch(() => {});
        }
      });
      await t.test('database read scope reads complete native-authorized rows but never enables writes or another database', async () => {
        await mysqlAdmin!.query('ALTER TABLE test.app_ro_reports ADD additional_field VARCHAR(128)');
        await mysqlAdmin!.query('UPDATE test.app_ro_reports SET additional_field=? WHERE id=1', ['all-fields-visible']);
        await db.collection<{ _id: string; name: string; additional_field?: string }>('app_ro_reports')
          .updateOne({ _id: 'one' }, { $set: { additional_field: 'all-fields-visible' } });
        const wideConfig = (writableIdentity: boolean, allowKeyspaceScan = false) => parseV2Config({ ...config, sources: config.sources.map(source => {
          if (source.engine === 'mysql') return { ...source, username: writableIdentity ? 'app_writer' : 'reader', access: { readScope: 'database' } };
          if (source.engine === 'redis') return { ...source, username: 'default', access: { readScope: 'database', allowKeyspaceScan } };
          return { ...source, connectionStringRef: 'env:' + envNames[writableIdentity ? 4 : 2], access: { readScope: 'database' } };
        }) });
        for (const writableIdentity of [false, true]) {
          const scoped = wideConfig(writableIdentity);
          const target = new SourceRegistry(scoped, createAdapterFactory());
          try {
            await target.initialize();
            const application = new Dispatcher(target);
            const read = async (name: string, args: Record<string, unknown>) => {
              const response = await application.call(name, args); assert.equal(response.isError, undefined, JSON.stringify(response));
              return JSON.parse(response.content[0].text).rows as Array<Record<string, unknown>>;
            };
            const object = writableIdentity ? 'app_ro_reports' : 'reports';
            const where = writableIdentity ? { _id: 'one' } : { id: 1 };
            const mysqlRows = await read('mysql_select', { sourceId: 'mysql', table: object, where: { id: 1 } });
            assert.deepEqual(mysqlRows, writableIdentity ? [{ id: 1, name: 'baseline', additional_field: 'all-fields-visible' }] : [{ id: 1, name: 'hello', password: 'hidden-value' }]);
            const mongoRows = await read('mongodb_find', { sourceId: 'mongo', collection: object, filter: where });
            assert.equal(mongoRows.length, 1); assert.ok(mongoRows[0]._id);
            if (writableIdentity) assert.deepEqual(mongoRows, [{ _id: 'one', name: 'baseline', additional_field: 'all-fields-visible' }]);
            else { assert.deepEqual(mongoRows[0].id, { $numberInt: '1' }); assert.equal(mongoRows[0].password, 'hidden-value'); }
            const mysqlNames = await read('mysql_list_tables', { sourceId: 'mysql' });
            assert.deepEqual(mysqlNames.map(row => row.TABLE_NAME), [object]);
            assert.ok(mysqlNames.every(row => row.TABLE_TYPE === 'BASE TABLE'));
            const mongoNames = await read('mongodb_list_collections', { sourceId: 'mongo' });
            assert.deepEqual(mongoNames, [{ name: object }]);
            const redisRows = await read('redis_get', { sourceId: 'redis', key: 'tenant2:hidden' });
            assert.equal(Buffer.from(redisRows[0].value as string, 'base64').toString(), 'hidden-value');
            assert.ok(application.tools().every(tool => !definitions.find(definition => definition.name === tool.name)?.requiresWrite));
            for (const [name, args] of [
              ['mysql_prepare_write', { sourceId: 'mysql', table: object, action: 'update', key: { id: 1 }, expectedVersion: 0, values: { name: 'must-not-write' } }],
              ['mongodb_prepare_write', { sourceId: 'mongo', collection: object, action: 'delete', key: { _id: 'one' }, expectedVersion: 0 }],
              ['redis_prepare_write', { sourceId: 'redis', key: 'tenant2:hidden', action: 'replace', value: 'must-not-write', expectedValue: 'hidden-value', expectedTtl: { mode: 'persistent' }, ttl: { mode: 'keep' } }],
              ['commit_write', { sourceId: 'mysql', operationId: randomUUID() }],
              ['operation_status', { sourceId: 'mongo', operationId: randomUUID() }],
              ['mysql_query', { sourceId: 'mysql', sql: 'DELETE FROM ' + object }],
              ['redis_eval', { sourceId: 'redis', script: "return redis.call('SET','tenant2:hidden','must-not-write')" }],
              ['redis_keys', { sourceId: 'redis' }],
            ] as const) {
              const denied = await application.call(name, args); assert.equal(denied.isError, true, name);
              assert.equal(JSON.parse(denied.content[0].text).error.code, 'SCOPE_DENIED', name);
            }
            for (const [name, args] of [
              ['mysql_select', { sourceId: 'mysql', table: 'mysql.user' }],
              ['mysql_select', { sourceId: 'mysql', table: object, database: 'mysql' }],
              ['mysql_list_tables', { sourceId: 'mysql', database: 'mysql' }],
              ['mongodb_find', { sourceId: 'mongo', collection: object, database: 'admin' }],
              ['mongodb_list_collections', { sourceId: 'mongo', database: 'admin' }],
              ['redis_get', { sourceId: 'redis', key: 'tenant2:hidden', database: 1 }],
            ] as const) assert.equal((await application.call(name, args)).isError, true, name);
            assert.deepEqual(await read('mysql_select', { sourceId: 'mysql', table: object, where: { id: 1 } }), mysqlRows);
            assert.deepEqual(await read('mongodb_find', { sourceId: 'mongo', collection: object, filter: where }), mongoRows);
            assert.equal(await redisAdmin!.get('tenant2:hidden'), 'hidden-value');
            const sqlNative = (await mysqlAdmin!.query('SELECT * FROM test.' + object + ' WHERE id=1'))[0];
            assert.deepEqual(sqlNative, mysqlRows);
            const mongoNative = await db.collection<{ _id: string | ObjectId }>(object).findOne(where, { promoteValues: false, bsonRegExp: true });
            assert.deepEqual(BSON.EJSON.serialize(mongoNative, { relaxed: false }), mongoRows[0]);
            // The default account is truly writable: application RO, not server grants,
            // was what stopped the forbidden MCP writes above.
            await redisAdmin!.set('database-test:temporary', 'native-control'); assert.equal(await redisAdmin!.del('database-test:temporary'), 1);
          } finally { await target.close(); }
        }
        const scanning = new SourceRegistry(parseV2Config({ ...wideConfig(false, true), sources: [wideConfig(false, true).sources.find(source => source.engine === 'redis')!] }), createReadAdapter);
        try {
          await scanning.initialize();
          const response = await new Dispatcher(scanning).call('redis_keys', { sourceId: 'redis', limit: 1 });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          const result = JSON.parse(response.content[0].text); assert.equal(result.rows.length, 1); assert.equal(result.truncated, true);
          assert.equal(typeof result.rows[0].key, 'string');
        } finally { await scanning.close(); }
        const allowedTables = await dispatcher.call('mysql_list_tables', { sourceId: 'mysql' });
        assert.equal(allowedTables.isError, undefined, JSON.stringify(allowedTables));
        assert.deepEqual(JSON.parse(allowedTables.content[0].text).rows.map((row: { TABLE_NAME: string }) => row.TABLE_NAME), ['reports']);
      });
      await t.test('MySQL JSON columns retain exact decimal and integer literals as raw JSON text', async () => {
        await mysqlAdmin!.query('CREATE TABLE test.json_reports (id INT PRIMARY KEY, payload JSON)');
        await mysqlAdmin!.query("GRANT SELECT ON test.json_reports TO 'reader'@'%'");
        await mysqlAdmin!.query("INSERT INTO test.json_reports VALUES (1, JSON_OBJECT('amount', CAST('1234567890123456789.123456789' AS DECIMAL(28,9)), 'id', CAST('9007199254740993' AS UNSIGNED), 'text', '9007199254740993')), (2, JSON_ARRAY(CAST('0.1234567890123456789012345678' AS DECIMAL(28,28)), '世界')), (3, 'null'), (4, NULL), (5, JSON_QUOTE('quoted \"text\"'))");
        const source = config.sources.find(source => source.engine === 'mysql')!;
        const selected = parseV2Config({ ...config, sources: [{ ...source, budgets: { ...source.budgets, maxRows: 10 },
          access: { tier: 'read_only', tables: ['json_reports'], columns: { json_reports: ['id', 'payload'] } } }] });
        const target = new SourceRegistry(selected, createAdapterFactory());
        try {
          await target.initialize();
          const response = await new Dispatcher(target).call('mysql_select', { sourceId: source.id, table: 'json_reports', orderBy: [{ field: 'id', direction: 'asc' }] });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          const data = JSON.parse(response.content[0].text);
          const [native] = await mysqlAdmin!.query('SELECT id, CAST(payload AS CHAR) AS payload FROM test.json_reports ORDER BY id');
          assert.deepEqual(data.rows, native);
          assert.equal(data.truncated, false);
          assert.ok(data.rows[0].payload.includes('1234567890123456789.123456789'));
          assert.ok(data.rows[0].payload.includes('9007199254740993'));
          assert.equal(data.rows[2].payload, 'null'); assert.equal(data.rows[3].payload, null);
        } finally { await target.close(); }
      });
      await t.test('MySQL streaming reads preserve legal database column names as own properties', async () => {
        await mysqlAdmin!.query('CREATE TABLE test.named_columns (id INT PRIMARY KEY, __lookupGetter__ TEXT, __proto__ TEXT)');
        await mysqlAdmin!.query("GRANT SELECT ON test.named_columns TO 'reader'@'%'");
        await mysqlAdmin!.query("INSERT INTO test.named_columns VALUES (1, 'specified', 'from star')");
        const source = config.sources.find(source => source.engine === 'mysql')!;
        for (const access of [{ tables: ['named_columns'], columns: { named_columns: ['__lookupGetter__'] } }, { readScope: 'database' }]) {
          const selected = parseV2Config({ ...config, sources: [{ ...source, access }] });
          const target = new SourceRegistry(selected, createAdapterFactory());
          try {
            await target.initialize();
            const response = await new Dispatcher(target).call('mysql_select', { sourceId: source.id, table: 'named_columns' });
            assert.equal(response.isError, undefined, JSON.stringify(response));
            const expected = 'tables' in access ? { __lookupGetter__: 'specified' } :
              { id: 1, __lookupGetter__: 'specified', ['__proto__']: 'from star' };
            assert.deepEqual(JSON.parse(response.content[0].text).rows, [expected]);
          } finally { await target.close(); }
        }
      });
      await t.test('Redis scan keys round trip as exact bytes through bounded read tools', async () => {
        const first = Buffer.concat([Buffer.from('tenant1:'), Buffer.from([0xff])]);
        const second = Buffer.concat([Buffer.from('tenant1:'), Buffer.from([0xfe])]);
        const long = 'tenant1:' + 'a'.repeat(525);
        const fixtures = [
          { raw: '', key: '', value: 'empty name' },
          { raw: long, key: long, value: 'long name' },
          { raw: first, key: { base64: first.toString('base64') }, value: 'first binary name' },
          { raw: second, key: { base64: second.toString('base64') }, value: 'second binary name' },
        ];
        for (const { raw, value } of fixtures) await redisAdmin!.set(raw, value);
        const source = config.sources.find(source => source.engine === 'redis')!;
        const selected = parseV2Config({ ...config, sources: [{ ...source, username: 'default',
          access: { allowKeyspaceScan: true }, budgets: { ...source.budgets, maxRows: 100 } }] });
        const target = new SourceRegistry(selected, createAdapterFactory());
        try {
          await target.initialize();
          const application = new Dispatcher(target);
          const scan = await application.call('redis_keys', { sourceId: source.id });
          assert.equal(scan.isError, undefined, JSON.stringify(scan));
          const result = JSON.parse(scan.content[0].text);
          assert.equal(result.truncated, false);
          const pagedKeys = [];
          let cursor: string | undefined;
          do {
            const page = await application.call('redis_keys', { sourceId: source.id, limit: 1, ...(cursor ? { cursor } : {}) });
            assert.equal(page.isError, undefined, JSON.stringify(page));
            const data = JSON.parse(page.content[0].text);
            assert.equal(data.rows.length, 1);
            pagedKeys.push(...data.rows.map((row: { key: unknown }) => JSON.stringify(row.key)));
            assert.ok(pagedKeys.length <= result.rows.length);
            cursor = data.nextCursor;
          } while (cursor);
          assert.deepEqual(pagedKeys.sort(), result.rows.map((row: { key: unknown }) => JSON.stringify(row.key)).sort());
          for (const { key, value } of fixtures) {
            assert.ok(result.rows.some((row: { key: unknown }) => JSON.stringify(row.key) === JSON.stringify(key)));
            const args = { sourceId: source.id, key };
            const type = await application.call('redis_type', args);
            assert.equal(type.isError, undefined, JSON.stringify(type));
            assert.deepEqual(JSON.parse(type.content[0].text).rows, [{ key, type: 'string' }]);
            const fragment = await application.call('redis_get_range', args);
            assert.equal(fragment.isError, undefined, JSON.stringify(fragment));
            assert.equal(Buffer.from(JSON.parse(fragment.content[0].text).rows[0].value, 'base64').toString(), value);
            const memory = await application.call('redis_memory_usage', args);
            assert.equal(memory.isError, undefined, JSON.stringify(memory));
            assert.ok(JSON.parse(memory.content[0].text).rows[0].bytes > 0);
          }
        } finally {
          await target.close();
          for (const { raw } of fixtures) await redisAdmin!.del(raw);
        }
      });
      await t.test('MySQL metadata uses exact fixed schema and table names even when the account can see case variants', async () => {
        const [settings] = await mysqlAdmin!.query<mysql.RowDataPacket[]>('SELECT @@lower_case_table_names AS value');
        assert.equal(settings[0].value, 0, 'This isolated regression needs case-sensitive schema/table names');
        await mysqlAdmin!.query('CREATE DATABASE `TEST`');
        await mysqlAdmin!.query('CREATE TABLE test.`Reports` (id INT, unlisted_secret VARCHAR(32))');
        await mysqlAdmin!.query('CREATE TABLE `TEST`.reports (other_database_column INT)');
        await mysqlAdmin!.query("CREATE USER 'metadata_reader'@'%' IDENTIFIED BY ?", [secret]);
        for (const object of ['test.reports', 'test.`Reports`', '`TEST`.reports'])
          await mysqlAdmin!.query("GRANT SELECT ON " + object + " TO 'metadata_reader'@'%'");
        const original = config.sources.find(source => source.engine === 'mysql')!;
        const observed: Record<string, unknown> = {};
        for (const scope of ['database', 'allowlist'] as const) {
          const scoped = parseV2Config({ ...config, sources: [{ ...original, username: 'metadata_reader',
            budgets: { ...original.budgets, maxRows: 100 },
            access: scope === 'database' ? { readScope: scope } : { readScope: scope, tables: ['reports'] } }] });
          const target = new SourceRegistry(scoped, createAdapterFactory());
          try {
            await target.initialize();
            const application = new Dispatcher(target);
            const listed = await application.call('mysql_list_tables', { sourceId: original.id });
            assert.equal(listed.isError, undefined, JSON.stringify(listed));
            observed[scope] = JSON.parse(listed.content[0].text).rows.map((row: { TABLE_NAME: string }) => row.TABLE_NAME).sort();
            const described = await application.call('mysql_describe_table', { sourceId: original.id, table: 'reports' });
            assert.equal(described.isError, undefined, JSON.stringify(described));
            observed[scope + '_columns'] = JSON.parse(described.content[0].text).rows.map((row: { COLUMN_NAME: string }) => row.COLUMN_NAME).sort();
          } finally { await target.close(); }
        }
        assert.deepEqual(observed, { database: ['Reports', 'reports'], allowlist: ['reports'],
          database_columns: ['id', 'name', 'password'], allowlist_columns: ['id', 'name', 'password'] });
      });
      await t.test('MySQL metadata pages advance through the authorized table and column order', async () => {
        await mysqlAdmin!.query('CREATE TABLE test.metadata_page_a (z_first INT, hidden_column INT, a_second TEXT)');
        await mysqlAdmin!.query('CREATE TABLE test.metadata_page_b (id INT)');
        await mysqlAdmin!.query("GRANT SELECT ON test.metadata_page_a TO 'reader'@'%'");
        await mysqlAdmin!.query("GRANT SELECT ON test.metadata_page_b TO 'reader'@'%'");
        const source = config.sources.find(item => item.engine === 'mysql')!;
        const selected = parseV2Config({ ...config, sources: [{ ...source, access: {
          tables: ['metadata_page_b', 'metadata_page_a'], columns: { metadata_page_a: ['a_second', 'z_first'] },
        } }] });
        const target = new SourceRegistry(selected, createAdapterFactory());
        try {
          await target.initialize();
          const application = new Dispatcher(target);
          for (const { tool, args, field, expected } of [
            { tool: 'mysql_list_tables', args: {}, field: 'TABLE_NAME', expected: ['metadata_page_a', 'metadata_page_b'] },
            { tool: 'mysql_describe_table', args: { table: 'metadata_page_a' }, field: 'COLUMN_NAME', expected: ['z_first', 'a_second'] },
          ]) {
            const input = { sourceId: source.id, limit: 1, ...args };
            const first = await application.call(tool, input);
            assert.equal(first.isError, undefined, first.content[0].text);
            const start = JSON.parse(first.content[0].text);
            assert.deepEqual(start.rows.map((row: Record<string, unknown>) => row[field]), expected.slice(0, 1));
            assert.equal(start.truncated, true); assert.equal(typeof start.nextCursor, 'string');
            const second = await application.call(tool, { ...input, cursor: start.nextCursor });
            assert.equal(second.isError, undefined, second.content[0].text);
            const end = JSON.parse(second.content[0].text);
            assert.deepEqual(end.rows.map((row: Record<string, unknown>) => row[field]), expected.slice(1));
            assert.equal(end.truncated, false); assert.equal(end.nextCursor, undefined);
          }
        } finally { await target.close(); }
      });
      await t.test('MongoDB native collection pages advance over only authorized names', async () => {
        const pageDb = mongoAdmin!.db('collection_pages');
        const permitted = ['page_a', 'page_b'];
        for (const name of [...permitted, 'hidden']) await pageDb.createCollection(name);
        await pageDb.command({ createRole: 'page_reader', privileges: permitted.map(collection =>
          ({ resource: { db: pageDb.databaseName, collection }, actions: ['find'] })), roles: [] });
        await pageDb.command({ createUser: 'page_reader', pwd: secret, roles: ['page_reader'] });
        process.env[envNames[5]] = 'mongodb://page_reader:' + secret + '@localhost:' + mongoPort + '/collection_pages';
        const source = config.sources.find(item => item.engine === 'mongodb')!;
        const selected = parseV2Config({ ...config, sources: [{
          ...source, database: pageDb.databaseName, connectionStringRef: 'env:' + envNames[5], access: { readScope: 'database' },
        }] });
        const target = new SourceRegistry(selected, createAdapterFactory());
        try {
          await target.initialize();
          const application = new Dispatcher(target);
          const input = { sourceId: source.id, limit: 1 };
          const first = await application.call('mongodb_list_collections', input);
          assert.equal(first.isError, undefined, first.content[0].text);
          const start = JSON.parse(first.content[0].text);
          assert.equal(start.rows.length, 1);
          assert.equal(start.truncated, true); assert.equal(typeof start.nextCursor, 'string');
          const second = await application.call('mongodb_list_collections', { ...input, cursor: start.nextCursor });
          assert.equal(second.isError, undefined, second.content[0].text);
          const end = JSON.parse(second.content[0].text);
          assert.equal(end.rows.length, 1);
          assert.equal(end.truncated, false); assert.equal(end.nextCursor, undefined);
          assert.deepEqual([...start.rows, ...end.rows].map(row => row.name).sort(), permitted);
        } finally { await target.close(); }
      });
      await t.test('MongoDB returns lossless canonical BSON values and optionally rejects collection scans', async () => {
        const special = { infinite: Infinity, nan: NaN, regex: /demo/i, minimum: new BSON.MinKey(), maximum: new BSON.MaxKey(),
          long: BSON.Long.fromString('9223372036854775807'), decimal: BSON.Decimal128.fromString('123456789.123456789'),
          binary: new BSON.Binary(Buffer.from([0, 255, 1]), 0x80) };
        await db.collection('reports').insertOne({ id: 100, name: special });
        const response = await call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { id: 100 } });
        assert.deepEqual(response.rows, [{ id: { $numberInt: '100' }, name: BSON.EJSON.serialize(special, { relaxed: false }) }]);
        const indexedConfig = parseV2Config({ ...config, sources: [{ ...config.sources.find(source => source.engine === 'mongodb')!, requireIndexedReads: true }] });
        const indexed = new SourceRegistry(indexedConfig, createAdapterFactory());
        try {
          await indexed.initialize();
          const application = new Dispatcher(indexed);
          const rejected = await application.call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } });
          assert.equal(rejected.isError, true);
          assert.equal(JSON.parse(rejected.content[0].text).error.code, 'QUERY_REQUIRES_INDEX');
          await db.collection('reports').createIndex({ id: 1 });
          const accepted = await application.call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { id: 1 } });
          assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
          assert.deepEqual(JSON.parse(accepted.content[0].text).rows, [{ id: { $numberInt: '1' }, name: 'hello' }]);
        } finally { await indexed.close(); }
      });
      await t.test('MongoDB overlapping and _id child projections work without exposing unselected fields', async () => {
        for (const [fields, expected] of [
          [['profile', 'profile.name'], { profile: { name: 'hello', email: 'hidden-email' } }],
          [['_id.tenant'], { _id: { tenant: { $numberInt: '7' } } }],
          [['profile.name'], { profile: { name: 'hello' } }],
        ] as const) {
          const scoped = parseV2Config({ ...config, sources: [{ ...base, id: 'mongo_nested', engine: 'mongodb', database: 'test', connectionStringRef: 'env:' + envNames[3],
            access: { tier: 'read_only', collections: ['nested_reports'], fields: { nested_reports: [...fields] } } }] });
          const target = new SourceRegistry(scoped, createAdapterFactory()); await target.initialize();
          try {
            const nested = new Dispatcher(target);
            const result = await nested.call('mongodb_find', { sourceId: 'mongo_nested', collection: 'nested_reports' });
            assert.equal(result.isError, undefined, JSON.stringify(result));
            assert.deepEqual(JSON.parse(result.content[0].text).rows, [expected]);
            if (fields.some(field => field === 'profile')) {
              const child = await nested.call('mongodb_find', { sourceId: 'mongo_nested', collection: 'nested_reports', fields: ['profile.name'] });
              assert.equal(child.isError, undefined, JSON.stringify(child));
              assert.deepEqual(JSON.parse(child.content[0].text).rows, [{ profile: { name: 'hello' } }]);
            }
            for (const args of [{ fields: ['password'] }, { fields: ['_id.private'] }, { filter: { password: 'hidden-value' } },
              ...(fields.some(field => field === 'profile') ? [] : [{ fields: ['profile'] }])]) {
              const denied = await nested.call('mongodb_find', { sourceId: 'mongo_nested', collection: 'nested_reports', ...args });
              assert.equal(denied.isError, true);
              assert.equal(JSON.parse(denied.content[0].text).error.code, 'SCOPE_DENIED');
            }
          } finally { await target.close(); }
        }
      });
      await t.test('real MySQL cancellation destroys the stream and releases capacity after cleanup', async () => {
        await mysqlAdmin!.query('CREATE VIEW test.v_slow AS SELECT SLEEP(2) AS waiting');
        await mysqlAdmin!.query("GRANT SELECT ON test.v_slow TO 'reader'@'%'");
        const source = config.sources.find(s => s.engine === 'mysql')!;
        const scoped = parseV2Config({ ...config, sources: [{ ...source, access: { tier: 'read_only', tables: ['v_slow'], columns: { v_slow: ['waiting'] } } }] });
        const target = new SourceRegistry(scoped, createAdapterFactory()); await target.initialize();
        try {
          const controller = new AbortController();
          const pending = new Dispatcher(target).call('mysql_select', { sourceId: 'mysql', table: 'v_slow' }, controller.signal);
          setTimeout(() => controller.abort(), 50);
          const result = await pending;
          assert.equal(JSON.parse(result.content[0].text).error.code, 'REQUEST_CANCELLED');
          await until(async () => { assert.equal(target.globalLimiter.snapshot().active, 0); });
        } finally { await target.close(); }
      });
      await t.test('Redis initialization with one application slot reserves AUTH/SELECT; sparse SCAN page limit applies', async () => {
        await redisAdmin!.sendCommand(['ACL', 'SETUSER', 'reader', '+select']);
        await redisAdmin!.select(1); await redisAdmin!.set('tenant1:one', 'db-one'); await redisAdmin!.select(0);
        const source = config.sources.find(s => s.engine === 'redis')!;
        const scoped = parseV2Config({ ...config, sources: [{ ...source, database: 1, budgets: { ...source.budgets, maxConcurrent: 1 } }] });
        const target = new SourceRegistry(scoped, createAdapterFactory()); await target.initialize();
        try {
          const result = await new Dispatcher(target).call('redis_get', { sourceId: 'redis', key: 'tenant1:one' });
          assert.equal(result.isError, undefined);
          assert.equal(Buffer.from(JSON.parse(result.content[0].text).rows[0].value, 'base64').toString(), 'db-one');
        } finally { await target.close(); }
        const multi = redisAdmin!.multi();
        for (let i = 0; i < 1000; i++) multi.set('tenant2:scan-test-' + i, 'x');
        await multi.exec();
        const scan = new SourceRegistry(parseV2Config({ ...config, sources: [{ ...source, budgets: { ...source.budgets, maxScanPages: 1 }, access: { ...source.access, keyPrefixes: ['tenant1:no-match:', 'tenant1:'] } }] }), createReadAdapter);
        await scan.initialize();
        try {
          const application = new Dispatcher(scan);
          const args = { sourceId: 'redis', prefix: 'tenant1:no-match:' };
          const start = await application.call('redis_keys', args);
          assert.equal(start.isError, undefined, JSON.stringify(start));
          let page = JSON.parse(start.content[0].text);
          assert.deepEqual(page.rows, []);
          assert.equal(page.reason, 'scan_pages');
          assert.equal(typeof page.nextCursor, 'string');
          const wrongPrefix = await application.call('redis_keys', { ...args, prefix: 'tenant1:', cursor: page.nextCursor });
          assert.equal(wrongPrefix.isError, true);
          assert.equal(JSON.parse(wrongPrefix.content[0].text).error.code, 'INVALID_ARGUMENT');
          for (let i = 0; i < 128 && page.nextCursor; i++) {
            const result = await application.call('redis_keys', { ...args, cursor: page.nextCursor });
            assert.equal(result.isError, undefined, JSON.stringify(result));
            page = JSON.parse(result.content[0].text);
            assert.deepEqual(page.rows, []);
          }
          assert.deepEqual(page, { rows: [], truncated: false });
        } finally { await scan.close(); }
      });
      await registry.close(); registry = undefined;
      await mysqlAdmin.end(); mysqlAdmin = undefined;
      await redisAdmin.disconnect(); redisAdmin = undefined;
      await mongoAdmin.close(); mongoAdmin = undefined;
      const expectTLSFailure = async (input: V2Config) => {
        const source = input.sources[0];
        if (source.engine === 'mysql') {
          // Isolated positive control only: prove the restarted server speaks MySQL and accepts
          // the same test identity. mysql2 can surface a TLS-alert race as CONNECTION_LOST.
          const control = await until(() => mysql.createConnection({ host: source.host, port: source.port, user: 'reader', password: secret,
            database: 'test', ssl: { rejectUnauthorized: false, verifyIdentity: false }, connectTimeout: 1000 }));
          try { await control.query('SELECT 1'); } finally { await control.end(); }
        }
        let handshakeError: unknown;
        const factory = createAdapterFactory();
        const target = new SourceRegistry(input, async (source, config) => {
          const adapter = await factory(source, config);
          const connect = adapter.connect.bind(adapter);
          adapter.connect = async () => {
            try { await connect(); }
            catch (error) { handshakeError = error; throw error; }
          };
          return adapter;
        });
        try {
          await assert.rejects(target.initialize(), (error: { code?: string }) => {
            // Refused TCP/startup failure must not be counted as a passed certificate assertion.
            const describe = (item: unknown): string => {
              if (item instanceof AggregateError) return item.errors.map(describe).join(' ');
              return String(item);
            };
            const detail = describe(handshakeError);
            const mysqlAlertRace = source.engine === 'mysql' &&
              (handshakeError as { code?: string } | undefined)?.code === 'PROTOCOL_CONNECTION_LOST';
            assert.ok(mysqlAlertRace || /certificate|cert_|altnames|SSL_HANDSHAKE/i.test(detail), source.engine + ': ' + detail.replaceAll(secret, '[REDACTED_SECRET]'));
            assert.equal(error.code, mysqlAlertRace ? 'SOURCE_UNAVAILABLE' : 'DATABASE_TLS_INVALID');
            return true;
          });
        } finally { await target.close(); }
      };
      await t.test('all drivers reject an untrusted CA', async () => {
        for (const source of config.sources) {
          await expectTLSFailure(parseV2Config({ ...config, sources: [{ ...source, tls: { mode: 'verify_identity', caFile: path.join(dir, 'bad-ca.pem') } }] }));
        }
      });
      await t.test('Redis and MongoDB reject absent IP SAN; MySQL IP TLS fails configuration', async () => {
        const redisSource = config.sources.find(s => s.engine === 'redis')!;
        await expectTLSFailure(parseV2Config({ ...config, sources: [{ ...redisSource, host: '127.0.0.1' }] }));
        const mysqlSource = config.sources.find(s => s.engine === 'mysql')!;
        assert.throws(() => parseV2Config({ ...config, sources: [{ ...mysqlSource, host: '127.0.0.1' }] }), /INVALID_CONFIG/);
        process.env[envNames[2]] = process.env[envNames[2]]!.replace('localhost:', '127.0.0.1:');
        await expectTLSFailure(parseV2Config({ ...config, sources: [config.sources.find(s => s.engine === 'mongodb')!] }));
        process.env[envNames[2]] = process.env[envNames[2]]!.replace('127.0.0.1:', 'localhost:');
      });
      for (const variant of ['wrong', 'expired']) {
        await t.test('all drivers reject ' + variant + ' certificates after database restart', async () => {
          await installCert(variant);
          const restarting = [...engineContainers].filter(([engine]) => variant !== 'expired' || engine !== 'mongo').map(([, id]) => id);
          const stopped = await Promise.allSettled(restarting.map(id => docker(['stop', id])));
          for (const result of stopped) if (result.status === 'rejected') throw result.reason;
          const started = await Promise.allSettled(restarting.map(id => docker(['start', id])));
          for (const result of started) if (result.status === 'rejected') throw result.reason;
          // Docker may allocate a different random host port after a restart. Resolve it again;
          // wait for TCP readiness so ECONNREFUSED cannot masquerade as a certificate failure.
          for (const source of config.sources) {
            if (variant === 'expired' && source.engine === 'mongodb') {
              // MongoDB refuses to start with an expired server certificate. Exercise the same
              // driver's TLS path against a controlled TLS endpoint; no DB authentication occurs.
              const endpoint = tlsServer({ key: await readFile(path.join(dir, 'server.key')), cert: await readFile(path.join(dir, 'expired.pem')) }, socket => socket.destroy());
              endpoint.on('tlsClientError', () => {});
              await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
              const address = endpoint.address(); assert.ok(address && typeof address !== 'string');
              process.env[envNames[2]] = `mongodb://reader:${secret}@localhost:${address.port}/test?authSource=test`;
              try { await expectTLSFailure(parseV2Config({ ...config, sources: [source] })); }
              finally { await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())); }
              continue;
            }
            const engine = source.engine === 'mongodb' ? 'mongo' : source.engine;
            const port = Number((await docker(['port', engineContainers.get(engine)!, String({ mysql: 3306, redis: 6379, mongo: 27017 }[engine])])).split(':').at(-1));
            await until(() => new Promise<void>((resolve, reject) => {
              const socket = tcpConnect({ host: '127.0.0.1', port });
              socket.setTimeout(1000);
              socket.once('connect', () => { socket.destroy(); resolve(); });
              socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('TCP timeout')); });
            }));
            if (source.engine === 'mongodb') {
              process.env[envNames[2]] = `mongodb://reader:${secret}@localhost:${port}/test?authSource=test`;
              await expectTLSFailure(parseV2Config({ ...config, sources: [source] }));
            } else await expectTLSFailure(parseV2Config({ ...config, sources: [{ ...source, port }] }));
          }
        });
      }
    } finally {
      await registry?.close(); await mysqlAdmin?.end().catch(() => {});
      if (redisAdmin?.isOpen) await redisAdmin.disconnect().catch(() => {});
      await mongoAdmin?.close().catch(() => {});
      const cleanup = await Promise.allSettled(containers.map(id => docker(['rm', '-f', '-v', id])));
      for (let i = 0; i < envNames.length; i++) { if (previous[i] === undefined) delete process.env[envNames[i]]; else process.env[envNames[i]] = previous[i]; }
      await rm(dir, { recursive: true });
      assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'Disposable container cleanup failed');
    }
  });
