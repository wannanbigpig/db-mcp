import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { Connection } from 'mysql2';
import { BSON } from 'mongodb';
import { Dispatcher, jsonSafe } from '../runtime/dispatcher.js';
import { ListRow } from '../runtime/pagination.js';
import { SourceRegistry } from '../runtime/sources.js';
import { parseV2Config, type SourceConfig } from '../config/v2.js';
import { MongoReadAdapter, MysqlReadAdapter, RedisReadAdapter } from '../runtime/adapters.js';

function source(engine: 'mysql', readScope: 'database' | 'allowlist'): Extract<SourceConfig, { engine: 'mysql' }>;
function source(engine: 'mongodb', readScope: 'database' | 'allowlist'): Extract<SourceConfig, { engine: 'mongodb' }>;
function source(engine: 'mysql' | 'mongodb', readScope: 'database' | 'allowlist'): SourceConfig {
  const config = parseV2Config({ version: 2, instance: { name: 'adapter-test', transport: 'stdio', environment: 'test' }, sources: [
    engine === 'mysql' ? { id: 'mysql', engine, host: 'localhost', database: 'test', username: 'reader', passwordRef: 'env:TEST_SECRET', tls: { mode: 'disabled' },
      access: { tables: ['reports'], columns: { reports: ['name'] } } } :
      { id: 'mongodb', engine, database: 'test', connectionStringRef: 'env:TEST_URI', tls: { mode: 'disabled' },
        access: { collections: ['reports'], fields: { reports: ['name'] } } },
  ] });
  const selected = config.sources[0];
  if (selected.engine === 'mysql') return { ...selected, access: Object.assign({ ...selected.access }, {
    readScope, ...(readScope === 'database' ? { tables: [], columns: {} } : {}),
  }) };
  if (selected.engine !== 'mongodb') throw new Error();
  return { ...selected, access: Object.assign({ ...selected.access }, {
    readScope, ...(readScope === 'database' ? { collections: [], fields: {} } : {}),
  }) };
}

test('MySQL table listing streams prepared fixed-database metadata and restricts allowlist names', async () => {
  for (const readScope of ['database', 'allowlist'] as const) {
    const configured = source('mysql', readScope);
    const adapter = new MysqlReadAdapter(configured, {});
    const calls: Array<{ sql: string; params: unknown[] }> = [], control: string[] = [];
    let destroyed = false, resultStream: Readable | undefined;
    const connection = {
      promise: () => ({ query: async (command: { sql: string }) => { control.push(command.sql); return [[], []]; } }),
      execute: (options: { sql: string; rowsAsArray: boolean; disableEval: boolean }, params: unknown[]) => {
        assert.equal(options.rowsAsArray, true); assert.equal(options.disableEval, true);
        calls.push({ sql: options.sql, params });
        const command = new EventEmitter();
        return Object.assign(command, { stream: (streamOptions: unknown) => {
          assert.deepEqual(streamOptions, { highWaterMark: 1 });
          command.emit('fields', [{ name: 'TABLE_NAME' }, { name: 'TABLE_TYPE' }]);
          resultStream = Readable.from([['reports', 'BASE TABLE']], { objectMode: true });
          return resultStream;
        } });
      }, destroy: () => { destroyed = true; },
    } as unknown as Connection;
    (adapter as unknown as { open: () => Promise<Connection> }).open = async () => connection;
    try {
      const rows = [];
      for await (const row of adapter.read({ tool: 'mysql_list_tables', limit: 1, position: 2 }, new AbortController().signal)) rows.push(row);
      assert.deepEqual(rows, [new ListRow({ TABLE_NAME: 'reports', TABLE_TYPE: 'BASE TABLE' }, 3)]);
      assert.deepEqual(control, ['SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION READ ONLY']);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /SELECT.*TABLE_NAME.*TABLE_TYPE.*FROM information_schema\.TABLES/s);
      assert.match(calls[0].sql, /WHERE TABLE_SCHEMA = \?/);
      assert.match(calls[0].sql, /ORDER BY TABLE_NAME, CAST\(TABLE_NAME AS BINARY\) LIMIT \? OFFSET \?$/);
      if (readScope === 'allowlist') { assert.match(calls[0].sql, /TABLE_NAME IN \(\?\)/); assert.deepEqual(calls[0].params, ['test', 'reports', 2, 2]); }
      else { assert.ok(!calls[0].sql.includes('TABLE_NAME IN')); assert.deepEqual(calls[0].params, ['test', 2, 2]); }
      assert.equal(destroyed, true); assert.equal(resultStream?.destroyed, true);
    } finally { await adapter.close(); }
  }
});

test('MongoDB database reads omit projection only when no explicit fields were selected', async () => {
  const configured = source('mongodb', 'database');
  const adapter = new MongoReadAdapter(configured, 'mongodb://reader:fixture-only@localhost:27017/test');
  const calls: Array<{ database: string; collection: string; options: Record<string, unknown> }> = [];
  let closed = 0;
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = database => ({ collection: (collection: string) => ({ find: (_filter: unknown, options: Record<string, unknown>) => {
    calls.push({ database, collection, options });
    return { async *[Symbol.asyncIterator]() { yield { _id: 'one', name: 'report', additional: 'all-fields' }; }, close: async () => { closed++; } };
  } }) });
  try {
    for (const fields of [undefined, ['name'], ['profile.name', 'profile']] as const) {
      for await (const _row of adapter.read({ tool: 'mongodb_find', target: 'reports', ...(fields ? { fields: [...fields] } : {}), limit: 1 }, new AbortController().signal)) {}
    }
    assert.ok(!Object.hasOwn(calls[0].options, 'projection'));
    assert.deepEqual(calls[1].options.projection, { name: 1, _id: 0 });
    assert.deepEqual(calls[2].options.projection, { profile: 1, _id: 0 });
    assert.ok(calls.every(call => call.database === 'test' && call.collection === 'reports'));
    assert.equal(closed, 3);
  } finally { await adapter.close(); }
});

test('MongoDB database collection listing is native, authorized, bounded and closes early', async () => {
  for (const earlyReturn of [false, true]) {
    const configured = source('mongodb', 'database');
    const adapter = new MongoReadAdapter(configured, 'mongodb://reader:fixture-only@localhost:27017/test');
    const controller = new AbortController();
    const calls: Array<{ database: string; filter: unknown; options: Record<string, unknown> }> = [];
    let fetched = 0, closed = false;
    const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
    client.db = database => ({ listCollections: (filter: unknown, options: Record<string, unknown>) => {
      calls.push({ database, filter, options });
      const next = async () => ++fetched <= 5 ? { name: 'reports_' + fetched, type: 'collection' } : null;
      return { next, async *[Symbol.asyncIterator]() { let value; while ((value = await next())) yield value; }, close: async () => { closed = true; } };
    } });
    try {
      const rows = [];
      for await (const row of adapter.read({ tool: 'mongodb_list_collections', limit: 2, position: 1 }, controller.signal)) {
        rows.push(row); if (earlyReturn) break;
      }
      const expected = (earlyReturn ? [2] : [2, 3, 4]).map(index => new ListRow({ name: 'reports_' + index }, index));
      assert.deepEqual(rows, expected);
      assert.equal(fetched, earlyReturn ? 2 : 4); assert.equal(closed, true);
      assert.equal(calls.length, 1); assert.equal(calls[0].database, 'test'); assert.deepEqual(calls[0].filter, {});
      assert.deepEqual(calls[0].options, { nameOnly: true, authorizedCollections: true, batchSize: 4, maxTimeMS: configured.budgets.queryTimeoutMs, signal: controller.signal });
    } finally { await adapter.close(); }
  }
});

test('MongoDB allowlist collection listing never invokes native enumeration', async () => {
  const configured = source('mongodb', 'allowlist');
  const adapter = new MongoReadAdapter({ ...configured, access: { ...configured.access, collections: ['reports', 'second', 'third', 'fourth'] } },
    'mongodb://reader:fixture-only@localhost:27017/test');
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = () => { throw new Error('UNEXPECTED_DATABASE_ENUMERATION'); };
  try {
    const rows = [];
    for await (const row of adapter.read({ tool: 'mongodb_list_collections', limit: 1, position: 1 }, new AbortController().signal)) rows.push(row);
    assert.deepEqual(rows, [new ListRow({ name: 'second' }, 2), new ListRow({ name: 'third' }, 3)]);
  } finally { await adapter.close(); }
});

test('MongoDB collection listing cancellation closes its cursor before requesting another batch', async () => {
  const adapter = new MongoReadAdapter(source('mongodb', 'database'), 'mongodb://reader:fixture-only@localhost:27017/test');
  const controller = new AbortController();
  let fetched = 0, closed = false;
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = () => ({ listCollections: () => ({ next: async () => ({ name: 'reports_' + ++fetched }), close: async () => { closed = true; } }) });
  try {
    const iterator = adapter.read({ tool: 'mongodb_list_collections', limit: 10 }, controller.signal)[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, new ListRow({ name: 'reports_1' }, 1));
    controller.abort();
    await assert.rejects(iterator.next(), /REQUEST_CANCELLED/);
    assert.equal(fetched, 1); assert.equal(closed, true);
  } finally { await adapter.close(); }
});

test('Redis read-only default identity uses password-only authentication while named users stay explicit', async () => {
  const configured = parseV2Config({ version: 2, instance: { name: 'redis-auth', transport: 'stdio', environment: 'test' }, sources: [{
    id: 'redis', engine: 'redis', host: 'localhost', username: 'reader', passwordRef: 'env:TEST_SECRET', tls: { mode: 'disabled' }, access: { keyPrefixes: ['reports:'] },
  }] }).sources[0];
  if (configured.engine !== 'redis') throw new Error();
  for (const username of ['default', 'reader']) {
    const adapter: RedisReadAdapter = new RedisReadAdapter({ ...configured, username }, 'fixture-only-secret');
    try {
      const client: { options: { username?: string } } = (adapter as unknown as { client: { options: { username?: string } } }).client;
      assert.equal(client.options.username, username === 'default' ? undefined : username);
      assert.equal(adapter.writer, undefined);
    } finally { await adapter.close(); }
  }
});

test('Redis WRONGTYPE keeps the source ready, while a terminal socket error marks it unavailable', { timeout: 5000 }, async () => {
  let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket;
    let pending = '';
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('ascii');
      const lines = pending.split('\r\n');
      while (lines.length >= 4) {
        const frameLines = Number(lines[0].slice(1)) * 2 + 1;
        if (lines.length <= frameLines) break;
        const command = lines[2];
        lines.splice(0, frameLines);
        socket.write(command === 'AUTH' ? '+OK\r\n' : command === 'PING' ? '+PONG\r\n' : command === 'TYPE' ? '+hash\r\n' :
          '-WRONGTYPE private-fixture-detail\r\n');
      }
      pending = lines.join('\r\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = parseV2Config({ version: 2, instance: { name: 'redis-state', transport: 'stdio', environment: 'test' }, sources: [{
    id: 'cache', engine: 'redis', host: '127.0.0.1', port: (server.address() as { port: number }).port,
    passwordRef: 'env:TEST_SECRET', tls: { mode: 'disabled' }, access: {},
  }] });
  const configured = config.sources[0];
  assert.equal(configured.engine, 'redis');
  const adapter = new RedisReadAdapter(configured, 'fixture-only-secret');
  const registry = new SourceRegistry(config, async () => adapter);
  const dispatcher = new Dispatcher(registry);
  const args = { sourceId: 'cache', key: 'reports:hash' };
  try {
    await registry.initialize();
    for (const tool of ['redis_get', 'redis_get_range']) {
      const result = await dispatcher.call(tool, args);
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).error.code, 'REDIS_WRONG_TYPE');
      assert.doesNotMatch(result.content[0].text, /private-fixture-detail/);
    }
    assert.equal(registry.list()[0].status, 'ready');
    const result = await dispatcher.call('redis_type', args);
    assert.deepEqual(JSON.parse(result.content[0].text).rows, [{ key: args.key, type: 'hash' }]);

    const socketError = once((adapter as unknown as { client: EventEmitter }).client, 'error');
    peer!.destroy();
    await socketError;
    const status = await dispatcher.call('list_sources', {});
    assert.deepEqual(JSON.parse(status.content[0].text).sources, [
      { id: 'cache', engine: 'redis', purpose: '', status: 'unavailable', errorCode: 'SOURCE_UNAVAILABLE',
        readScope: 'database', maxRows: 200, enabledTools: ['redis_get', 'redis_get_range', 'redis_type', 'redis_memory_usage'] },
    ]);
    const disconnected = await dispatcher.call('redis_type', args);
    assert.equal(JSON.parse(disconnected.content[0].text).error.code, 'SOURCE_UNAVAILABLE');
  } finally {
    await registry.close();
    peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test('MongoDB reads preserve BSON values and types through the JSON response boundary', async () => {
  const adapter = new MongoReadAdapter(source('mongodb', 'database'), 'mongodb://reader:fixture-only@localhost:27017/test');
  const legacy = BSON.serialize({ value: null });
  legacy[4] = BSON.BSONType.undefined; // Same wire size as BSON null.
  const document = BSON.deserialize(BSON.serialize({
    id: new BSON.ObjectId('0123456789abcdef01234567'),
    int: new BSON.Int32(42), double: new BSON.Double(42), big: BSON.Long.fromString('9223372036854775807'),
    decimal: BSON.Decimal128.fromString('12345678901234567890.123456789'),
    date: new Date('2026-01-02T03:04:05.000Z'),
    binary: new BSON.Binary(Buffer.from([0, 255]), 0x80),
    nested: { positive: Infinity, nan: NaN, regex: new BSON.BSONRegExp('a+b', 'im'), min: new BSON.MinKey(), max: new BSON.MaxKey() },
  }), { promoteValues: false, bsonRegExp: true });
  const deprecated = BSON.deserialize(legacy).value;
  document.legacy = [null, deprecated];
  document.codeWithScope = new BSON.Code('0', { deprecated });
  document.reference = new BSON.DBRef('reports', document.id, 'test', { deprecated });
  let options: Record<string, unknown> = {}, closed = false;
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = () => ({ collection: () => ({ find: (_filter: unknown, value: Record<string, unknown>) => {
    options = value;
    return { async *[Symbol.asyncIterator]() { yield document; }, close: async () => { closed = true; } };
  } }) });
  try {
    const rows = [];
    for await (const row of adapter.read({ tool: 'mongodb_find', target: 'reports', limit: 1 }, new AbortController().signal)) rows.push(JSON.parse(jsonSafe(row)));
    assert.deepEqual(rows, [{
      id: { $oid: '0123456789abcdef01234567' }, int: { $numberInt: '42' }, double: { $numberDouble: '42.0' },
      big: { $numberLong: '9223372036854775807' }, decimal: { $numberDecimal: '12345678901234567890.123456789' },
      date: { $date: { $numberLong: '1767323045000' } }, binary: { $binary: { base64: 'AP8=', subType: '80' } },
      nested: { positive: { $numberDouble: 'Infinity' }, nan: { $numberDouble: 'NaN' },
        regex: { $regularExpression: { pattern: 'a+b', options: 'im' } }, min: { $minKey: 1 }, max: { $maxKey: 1 } },
      legacy: [null, { $undefined: true }],
      codeWithScope: { $code: '0', $scope: { deprecated: { $undefined: true } } },
      reference: { $ref: 'reports', $id: { $oid: '0123456789abcdef01234567' }, $db: 'test', deprecated: { $undefined: true } },
    }]);
    assert.equal(options.promoteValues, false); assert.equal(options.bsonRegExp, true);
    assert.equal(closed, true);
  } finally { await adapter.close(); }
});

test('MongoDB rejects a BSON Date the driver cannot represent and closes the cursor', async () => {
  const configured = source('mongodb', 'database');
  const config = parseV2Config({ version: 2, instance: { name: 'bson-date', transport: 'stdio', environment: 'test' },
    sources: [configured] });
  const adapter = new MongoReadAdapter(configured, 'mongodb://reader:fixture-only@localhost:27017/test');
  const binary = Buffer.from(BSON.serialize({ date: new Date(0) }));
  binary.writeBigInt64LE(9223372036854775807n, binary.length - 9);
  const item = BSON.deserialize(binary, { promoteValues: false });
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  let closed = false;
  client.db = () => ({ collection: () => ({ find: () => ({
    async *[Symbol.asyncIterator]() { yield { nested: [item] }; },
    close: async () => { closed = true; },
  }) }) });
  const registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: () => adapter.close(), read: adapter.read.bind(adapter) }));
  try {
    await registry.initialize();
    const result = await new Dispatcher(registry).call('mongodb_find', { sourceId: 'mongodb', collection: 'reports', limit: 1 });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'BSON_DATE_OUT_OF_RANGE');
    assert.equal(closed, true);
  } finally { await registry.close(); }
});

test('MongoDB item budgets include Extended JSON type wrappers before returning data', async () => {
  const configured = source('mongodb', 'database');
  const config = parseV2Config({ version: 2, instance: { name: 'bson-budget', transport: 'stdio', environment: 'test' },
    sources: [{ ...configured, budgets: { ...configured.budgets, maxItemBytes: 256 } }],
  });
  const adapter = new MongoReadAdapter(configured, 'mongodb://reader:fixture-only@localhost:27017/test');
  const document = { payload: new BSON.Binary(Buffer.alloc(160), 0x80) };
  assert.ok(Buffer.byteLength(JSON.stringify(document)) < 256);
  assert.ok(Buffer.byteLength(BSON.EJSON.stringify(document, { relaxed: false })) > 256);
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = () => ({ collection: () => ({ find: () => ({
    async *[Symbol.asyncIterator]() { yield document; }, close: async () => {},
  }) }) });
  const registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: () => adapter.close(), read: adapter.read.bind(adapter) }));
  try {
    await registry.initialize();
    const result = await new Dispatcher(registry).call('mongodb_find', { sourceId: 'mongodb', collection: 'reports', limit: 1 });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { rows: [], truncated: true, reason: 'item_bytes' });
  } finally { await registry.close(); }
});


test('MongoDB optional index check rejects collection scans and unknown plans before reading', async () => {
  const scenarios = [
    { enabled: false, winningPlan: { stage: 'COLLSCAN' }, allowed: true },
    { enabled: true, winningPlan: { stage: 'COLLSCAN' }, allowed: false },
    { enabled: true, winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN' } }, allowed: true },
    { enabled: true, winningPlan: { queryPlan: { stage: 'LIMIT', inputStage: { stage: 'IXSCAN' } }, slotBasedPlan: { stages: 'internal plan' } }, allowed: true },
    { enabled: true, winningPlan: { stage: 'OR', inputStages: [{ stage: 'IXSCAN' }, { stage: 'COLLSCAN' }] }, allowed: false },
    { enabled: true, winningPlan: { stage: 'UNRECOGNIZED_PLAN', inputStage: { stage: 'IXSCAN' } }, allowed: false },
    { enabled: true, winningPlan: {}, allowed: false },
  ];
  for (const scenario of scenarios) {
    const adapter = new MongoReadAdapter({ ...source('mongodb', 'database'), requireIndexedReads: scenario.enabled }, 'mongodb://reader:fixture-only@localhost:27017/test');
    let explained = 0, read = false, closed = false;
    const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
    client.db = () => ({ collection: () => ({ find: (filter: unknown, options: Record<string, unknown>) => {
      assert.deepEqual(filter, { name: 'visible' }); assert.deepEqual(options.projection, { name: 1, _id: 0 });
      assert.deepEqual(options.sort, { name: 1 }); assert.equal(options.limit, 1); assert.ok(options.signal instanceof AbortSignal);
      assert.ok(Number(options.maxTimeMS) > 0);
      return {
        explain: async (verbosity: string) => {
          assert.equal(verbosity, 'queryPlanner'); explained++;
          return { queryPlanner: { winningPlan: scenario.winningPlan, rejectedPlans: [{ stage: 'COLLSCAN' }] } };
        },
        async *[Symbol.asyncIterator]() { read = true; yield { name: 'visible' }; },
        close: async () => { closed = true; },
      };
    } }) });
    try {
      const request = async () => {
        const rows = [];
        for await (const row of adapter.read({ tool: 'mongodb_find', target: 'reports', filter: { name: 'visible' }, fields: ['name'],
          orderBy: [{ field: 'name', direction: 'asc' }], limit: 1 }, new AbortController().signal)) rows.push(row);
        return rows;
      };
      if (scenario.allowed) assert.deepEqual(await request(), [{ name: 'visible' }]);
      else await assert.rejects(request(), { code: 'QUERY_REQUIRES_INDEX' });
      assert.equal(explained, scenario.enabled ? 1 : 0); assert.equal(read, scenario.allowed); assert.equal(closed, true);
    } finally { await adapter.close(); }
  }
});

test('MongoDB cancellation during index checking closes the cursor without reading', async () => {
  const adapter = new MongoReadAdapter({ ...source('mongodb', 'database'), requireIndexedReads: true }, 'mongodb://reader:fixture-only@localhost:27017/test');
  const controller = new AbortController(); let read = false, closed = false;
  const client = (adapter as unknown as { client: { db(name: string): unknown } }).client;
  client.db = () => ({ collection: () => ({ find: () => ({
    explain: async () => { controller.abort(); return { queryPlanner: { winningPlan: { stage: 'IXSCAN' } } }; },
    async *[Symbol.asyncIterator]() { read = true; yield { name: 'visible' }; }, close: async () => { closed = true; },
  }) }) });
  try {
    const request = async () => { for await (const _row of adapter.read({ tool: 'mongodb_find', target: 'reports', limit: 1 }, controller.signal)) {} };
    await assert.rejects(request(), { code: 'REQUEST_CANCELLED' });
    assert.equal(read, false); assert.equal(closed, true);
  } finally { await adapter.close(); }
});
