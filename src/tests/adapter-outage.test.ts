import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Connection } from 'mysql2';
import { parseV2Config } from '../config/v2.js';
import { MysqlReadAdapter, mysqlPreviewTransaction } from '../runtime/adapters/mysql.js';
import { RedisReadAdapter } from '../runtime/adapters/redis.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { SafeError } from '../runtime/errors.js';
import { SourceRegistry } from '../runtime/sources.js';
import type { MysqlWritePlan, RedisWritePlan } from '../runtime/write-policy.js';

async function redisFixture(type: (peer: Socket) => void) {
  const peers = new Set<Socket>();
  const info = 'redis_version:7.4.0\r\n';
  const server = createServer(peer => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.once('close', () => peers.delete(peer));
    let pending = '';
    peer.on('data', chunk => {
      pending += chunk.toString('ascii');
      const lines = pending.split('\r\n');
      for (; lines.length >= 4;) {
        const frameLines = Number(lines[0].slice(1)) * 2 + 1;
        if (lines.length <= frameLines) break;
        const command = lines[2];
        lines.splice(0, frameLines);
        if (command === 'TYPE') type(peer);
        else peer.write(command === 'AUTH' ? '+OK\r\n' : command === 'PING' ? '+PONG\r\n' :
          command === 'INFO' ? '$' + Buffer.byteLength(info) + '\r\n' + info + '\r\n' : '-ERR unsupported fixture command\r\n');
      }
      pending = lines.join('\r\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, async close() {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

function redisConfig(port: number, queryTimeoutMs: number, tier: 'read_write' | 'read_only' = 'read_only') {
  return parseV2Config({ version: 2, instance: { name: 'redis-outage', environment: 'test', transport: 'stdio', tier,
    ...(tier === 'read_write' ? { journal: { directory: '/tmp/db-mcp-redis-outage-fixture' } } : {}) }, sources: [{
    id: 'cache', engine: 'redis', host: '127.0.0.1', port, username: 'reader', passwordRef: 'env:UNUSED_FIXTURE',
    tls: { mode: 'disabled' }, budgets: { maxConcurrent: 1, maxConnections: 1, queryTimeoutMs },
    access: { tier, keyPrefixes: ['fixture:'], ...(tier === 'read_write' ? { writes: { allowCreate: true } } : {}) },
  }] });
}

const typeArgs = { sourceId: 'cache', key: 'fixture:key' };

test('a silent Redis read retires the connection and releases its held request budget', { timeout: 3000 }, async () => {
  let count = 0;
  const server = await redisFixture(() => { count++; });
  const config = redisConfig(server.port, 80);
  const source = config.sources[0];
  assert.equal(source.engine, 'redis');
  const adapter = new RedisReadAdapter(source, 'disposable-fixture');
  const registry = new SourceRegistry(config, async () => adapter);
  const dispatcher = new Dispatcher(registry);
  try {
    await registry.initialize();
    const result = await dispatcher.call('redis_type', typeArgs);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'REQUEST_CANCELLED');
    for (let i = 0; i < 20 && registry.globalLimiter.snapshot().active !== 0; i++) await delay(10);
    assert.equal(count, 1);
    assert.equal(registry.globalLimiter.snapshot().active, 0);
    assert.equal(registry.list()[0].status, 'unavailable');
  } finally { await registry.close(); await server.close(); }
});

test('early caller cancellation lets a Redis command finish without closing the healthy connection', { timeout: 3000 }, async () => {
  let receive!: (peer: Socket) => void;
  const received = new Promise<Socket>(resolve => { receive = resolve; });
  let count = 0;
  const server = await redisFixture(peer => {
    if (++count === 1) receive(peer);
    else peer.write('+string\r\n');
  });
  const config = redisConfig(server.port, 1000);
  const source = config.sources[0];
  assert.equal(source.engine, 'redis');
  const adapter = new RedisReadAdapter(source, 'disposable-fixture');
  const registry = new SourceRegistry(config, async () => adapter);
  const dispatcher = new Dispatcher(registry);
  try {
    await registry.initialize();
    const controller = new AbortController();
    const pending = dispatcher.call('redis_type', typeArgs, controller.signal);
    const peer = await Promise.race([received, pending.then(() => { throw new Error('Redis command did not reach the fixture'); })]);
    controller.abort();
    const cancelled = await pending;
    assert.equal(JSON.parse(cancelled.content[0].text).error.code, 'REQUEST_CANCELLED');
    assert.equal(registry.globalLimiter.snapshot().active, 1);
    peer.write('+string\r\n');
    const next = await dispatcher.call('redis_type', typeArgs);
    assert.deepEqual(JSON.parse(next.content[0].text).rows, [{ key: typeArgs.key, type: 'string' }]);
    assert.equal(registry.list()[0].status, 'ready');
    assert.equal(count, 2);
  } finally { await registry.close(); await server.close(); }
});

test('a silent Redis write preview settles on the read connection deadline and reports loss once', { timeout: 3000 }, async () => {
  const fixture = await redisFixture(() => {});
  const source = redisConfig(fixture.port, 80, 'read_write').sources[0];
  assert.equal(source.engine, 'redis');
  const adapter = new RedisReadAdapter(source, 'disposable-fixture');
  const notifications: string[] = [];
  adapter.onUnavailable(code => notifications.push(code));
  const plan: RedisWritePlan = { tool: 'redis_prepare_write', engine: 'redis', sourceId: 'cache',
    action: 'create', target: typeArgs.key, value: 'next', ttl: { mode: 'clear' } };
  try {
    await adapter.connect();
    const preview = adapter.writer!.preview(plan, new AbortController().signal);
    const stalled = delay(400, undefined, { ref: false }).then(() => { throw new Error('preview remained pending'); });
    await assert.rejects(Promise.race([preview, stalled]), { code: 'REQUEST_CANCELLED' });
    assert.deepEqual(notifications, ['SOURCE_UNAVAILABLE']);
  } finally { await adapter.close(); await fixture.close(); }
});

test('MySQL cancellation and shutdown close stalled handshake transports', { timeout: 4000 }, async () => {
  const peers = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, peer => {
    peers.add(peer);
    peer.once('close', () => peers.delete(peer));
    // Send no handshake and leave the writable side open after receiving FIN.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const source = parseV2Config({ version: 2, instance: { name: 'mysql-outage', environment: 'test', transport: 'stdio' }, sources: [{
    id: 'mysql', engine: 'mysql', host: '127.0.0.1', port: address.port, database: 'test', username: 'reader',
    passwordRef: 'env:UNUSED_FIXTURE', tls: { mode: 'disabled' }, access: {}, budgets: { maxConnections: 1 },
  }] }).sources[0];
  assert.equal(source.engine, 'mysql');
  const sockets: Socket[] = [];
  const adapter = new MysqlReadAdapter(source, { connectTimeout: 2000, stream: () => {
    const socket = createConnection({ host: address.address, port: address.port });
    sockets.push(socket);
    return socket;
  } });
  try {
    for (let i = 0; i < 3; i++) {
      const accepted = once(server, 'connection');
      const controller = new AbortController();
      const read = adapter.read({ tool: 'mysql_list_tables', limit: 1 }, controller.signal)[Symbol.asyncIterator]();
      const pending = assert.rejects(read.next(), { code: 'REQUEST_CANCELLED' });
      await accepted;
      controller.abort();
      await pending;
      assert.ok(sockets[i].closed, 'the driver transport must close before the adapter settles');
    }
    const accepted = once(server, 'connection');
    const starting = assert.rejects(adapter.connect(), { code: 'SOURCE_UNAVAILABLE' });
    await accepted;
    await adapter.close();
    await starting;
    assert.ok(sockets[3].closed, 'shutdown must await the startup transport close');
  } finally {
    await adapter.close();
    for (const socket of sockets) socket.destroy();
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('MySQL preview distinguishes transport errors from rejected schema inspection', async () => {
  const source = parseV2Config({ version: 2, instance: { name: 'mysql-outage', environment: 'test', transport: 'stdio',
    tier: 'read_write', journal: { directory: '/tmp/db-mcp-mysql-outage-fixture' } }, sources: [{
    id: 'mysql', engine: 'mysql', host: '127.0.0.1', database: 'test', username: 'writer', passwordRef: 'env:UNUSED_FIXTURE',
    tls: { mode: 'disabled' }, access: { tier: 'read_write', tables: ['items'], columns: { items: ['id', 'version', 'name'] },
      writes: { metadataGuard: 'mcp_write_metadata', tables: {
        items: { keyColumns: ['id'], versionColumn: 'version', writableColumns: ['name'], allowInsert: true },
      } } },
  }] }).sources[0];
  assert.equal(source.engine, 'mysql');
  const plan: MysqlWritePlan = { tool: 'mysql_prepare_write', engine: 'mysql', sourceId: 'mysql', target: 'items',
    action: 'insert', key: { id: 1 }, versionColumn: 'version', values: { name: 'next' } };
  const failures = [
    [Object.assign(new Error('fixture protocol connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }), 'SOURCE_UNAVAILABLE'],
    [Object.assign(new Error('fixture guard unavailable'), { code: 'ER_SP_DOES_NOT_EXIST' }), 'SCHEMA_UNSAFE'],
    [new SafeError('REQUEST_CANCELLED'), 'REQUEST_CANCELLED'],
  ] as const;
  for (const [failure, code] of failures) {
    let destroyed = false;
    const connection = { promise: () => ({ query: async (sql: string) => {
      if (sql.startsWith('CALL')) throw failure;
      return [[], []];
    }, execute: async () => [[], []] }), destroy: () => { destroyed = true; } } as unknown as Connection;
    await assert.rejects(mysqlPreviewTransaction(connection, source, plan, new AbortController().signal), { code });
    assert.equal(destroyed, true);
  }
});
