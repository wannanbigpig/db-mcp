import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseV2Config } from '../config/v2.js';
import { resolveSecret } from '../config/secrets.js';
import { SourceRegistry, type ReadAdapter } from '../runtime/sources.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { definitions } from '../runtime/tool-catalog.js';
import { validateMongoURI, MongoReadAdapter, RedisReadAdapter } from '../runtime/adapters.js';
import { ConcurrencyLimiter } from '../utils/concurrency.js';
import { BoundedStdioTransport } from '../runtime/stdio.js';
import { PassThrough } from 'node:stream';

export function mysqlConfig() {
  return {
    version: 2,
    instance: { name: 'test-read', transport: 'stdio', environment: 'test', tier: 'read_only' },
    sources: [{
      id: 'db1', engine: 'mysql', required: true,
      host: '127.0.0.1', port: 3306, database: 'test', username: 'mcp_reader',
      passwordRef: 'env:TEST_DB_SECRET', tls: { mode: 'disabled' },
      access: { tier: 'read_only', tables: ['reports'], columns: { reports: ['id', 'name'] }, rawSql: false },
    }],
  };
}

test('v2 configuration is strict and rejects unsafe defaults', () => {
  const config = parseV2Config(mysqlConfig());
  assert.equal(config.sources[0].id, 'db1');
  for (const mutate of [
    (c: any) => { c.version = 1; },
    (c: any) => { c.sources[0].password = 'do-not-print'; },
    (c: any) => { c.sources[0].username = 'root'; },
    (c: any) => { c.instance.tier = 'admin'; },
    (c: any) => { c.sources[0].access.rawSql = true; },
    (c: any) => { c.sources.push(structuredClone(c.sources[0])); },
    (c: any) => { c.sources[0].budgets = { maxRows: 0 }; },
  ]) {
    const input = mysqlConfig(); mutate(input);
    assert.throws(() => parseV2Config(input), /INVALID_CONFIG/);
  }
});

test('omitted tiers default independently to read-only without coercing invalid modes', () => {
  for (const missing of ['instance', 'source', 'both']) {
    const input = mysqlConfig();
    if (missing !== 'source') Reflect.deleteProperty(input.instance, 'tier');
    if (missing !== 'instance') Reflect.deleteProperty(input.sources[0].access, 'tier');
    const config = parseV2Config(input);
    assert.equal(config.instance.tier, 'read_only');
    assert.equal(config.sources[0].access.tier, 'read_only');
    assert.ok(Object.isFrozen(config.instance)); assert.ok(Object.isFrozen(config.sources[0].access));
  }
  const writeInstance = mysqlConfig();
  writeInstance.instance.tier = 'read_write';
  Object.assign(writeInstance.instance, { journal: { directory: '/tmp/db-mcp-default-tier-test' } });
  Reflect.deleteProperty(writeInstance.sources[0].access, 'tier');
  const mixed = parseV2Config(writeInstance);
  assert.equal(mixed.instance.tier, 'read_write'); assert.equal(mixed.sources[0].access.tier, 'read_only');
  for (const value of [null, false, '', 'full_access', 'admin', 'READ_ONLY']) {
    for (const sourceMode of [false, true]) {
      const input = mysqlConfig();
      Reflect.set(sourceMode ? input.sources[0].access : input.instance, 'tier', value);
      assert.throws(() => parseV2Config(input), /INVALID_CONFIG/);
    }
  }
});

test('default read-only rejects direct write tools even with a write-capable adapter and tool allowlist', async () => {
  const input = mysqlConfig();
  Reflect.deleteProperty(input.instance, 'tier'); Reflect.deleteProperty(input.sources[0].access, 'tier');
  Object.assign(input.sources[0].access, { allowedTools: ['mysql_select', 'mysql_prepare_write'] });
  let reads = 0, previews = 0, writes = 0;
  const adapter: ReadAdapter = {
    connect: async () => {}, close: async () => {},
    read: async function* () { reads++; yield { id: 1, name: 'baseline' }; },
    writer: {
      preview: async () => { previews++; return { fingerprint: 'unused', condition: 'match' }; },
      write: async () => { writes++; return { state: 'success', directAffected: 1 }; },
    },
  };
  const registry = new SourceRegistry(parseV2Config(input), async () => adapter);
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const writeNames = definitions.filter(tool => tool.requiresWrite).map(tool => tool.name);
    assert.ok(dispatcher.tools().every(tool => !writeNames.includes(tool.name)));
    for (const name of [...writeNames, 'mysql_query', 'redis_eval', 'mongodb_update', 'set_security_mode']) {
      const result = await dispatcher.call(name, { sourceId: 'db1', mode: 'full_access' });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).error.code, 'SCOPE_DENIED');
    }
    const escalation = await dispatcher.call('mysql_select', { sourceId: 'db1', table: 'reports', tier: 'read_write' });
    assert.equal(JSON.parse(escalation.content[0].text).error.code, 'INVALID_ARGUMENT');
    assert.equal(reads, 0); assert.equal(previews, 0); assert.equal(writes, 0);
    const selected = await dispatcher.call('mysql_select', { sourceId: 'db1', table: 'reports' });
    assert.equal(selected.isError, undefined);
    assert.deepEqual(JSON.parse(selected.content[0].text).rows, [{ id: 1, name: 'baseline' }]);
    const status = await dispatcher.call('server_runtime_status', {});
    assert.equal(JSON.parse(status.content[0].text).tier, 'read_only');
    assert.equal(reads, 1); assert.equal(previews, 0); assert.equal(writes, 0);
  } finally { await registry.close(); }
});

test('secret resolution rejects missing/empty env and unsafe files without echoing input', async () => {
  await assert.rejects(resolveSecret('env:TEST_DB_SECRET', {}), /SECRET_UNAVAILABLE/);
  await assert.rejects(resolveSecret('env:TEST_DB_SECRET', { TEST_DB_SECRET: '' }), /SECRET_UNAVAILABLE/);
  assert.equal(await resolveSecret('env:TEST_DB_SECRET', { TEST_DB_SECRET: 'private-value' }), 'private-value');
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-secret-'));
  try {
    const file = path.join(dir, 'secret');
    await writeFile(file, 'private-value\n', { mode: 0o600 });
    assert.equal(await resolveSecret('file:' + file), 'private-value');
    await chmod(file, 0o644);
    await assert.rejects(resolveSecret('file:' + file), /SECRET_UNAVAILABLE/);
    await chmod(file, 0o600);
    await symlink(file, path.join(dir, 'link'));
    await assert.rejects(resolveSecret('file:' + path.join(dir, 'link')), /SECRET_UNAVAILABLE/);
    await writeFile(file, Buffer.from([0xff]));
    await assert.rejects(resolveSecret('file:' + file), /SECRET_UNAVAILABLE/);
  } finally { await rm(dir, { recursive: true }); }
});

test('fixed catalog and direct calls reject writes, credentials and out-of-scope reads before adapters', async () => {
  let calls = 0;
  const adapter: ReadAdapter = {
    connect: async () => {}, close: async () => {},
    read: async function* () { calls++; yield { id: 1, name: 'ok' }; },
  };
  const registry = new SourceRegistry(parseV2Config(mysqlConfig()), async () => adapter);
  await registry.initialize();
  const dispatcher = new Dispatcher(registry);
  try {
    const names = dispatcher.tools().map(t => t.name);
    assert.ok(names.includes('mysql_select'));
    assert.ok(!names.includes('mysql_connect'));
    assert.ok(!names.includes('mysql_query'));
    assert.ok(!names.includes('mysql_update'));
    for (const [name, args] of [
      ['mysql_update', { sourceId: 'db1', table: 'reports' }],
      ['mysql_select', { sourceId: 'unknown', table: 'reports' }],
      ['mysql_select', { sourceId: 'db1', table: 'secrets' }],
      ['mysql_select', { sourceId: 'db1', table: 'reports', columns: ['password'] }],
      ['mysql_select', { sourceId: 'db1', table: 'reports', where: { password: 'x' } }],
      ['mysql_select', { sourceId: 'db1', table: 'reports', password: 'private-value' }],
    ] as const) {
      const response = await dispatcher.call(name, args);
      assert.equal(response.isError, true);
      assert.ok(!JSON.stringify(response).includes('private-value'));
    }
    assert.equal(calls, 0);
    const response = await dispatcher.call('mysql_select', { sourceId: 'db1', table: 'reports', limit: 2 });
    assert.equal(response.isError, undefined);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(response.content[0].text).rows, [{ id: 1, name: 'ok' }]);
    const status = await dispatcher.call('list_sources', {});
    assert.ok(!JSON.stringify(status).includes('passwordRef'));
    assert.ok(!JSON.stringify(status).includes('127.0.0.1'));
  } finally { await registry.close(); }
});

test('bounded reads stop the iterator and clean up at row and byte limits', async () => {
  let fetched = 0, closed = false;
  const input = mysqlConfig();
  (input.sources[0] as any).budgets = { maxRows: 2, maxItemBytes: 1024, maxResponseBytes: 2048 };
  const adapter: ReadAdapter = {
    connect: async () => {}, close: async () => {},
    read: async function* () {
      try { for (let i = 0; i < 100; i++) { fetched++; yield { id: i, name: '中'.repeat(40) }; } }
      finally { closed = true; }
    },
  };
  const registry = new SourceRegistry(parseV2Config(input), async () => adapter);
  await registry.initialize();
  try {
    const response = await new Dispatcher(registry).call('mysql_select', { sourceId: 'db1', table: 'reports' });
    assert.equal(JSON.parse(response.content[0].text).truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 2048);
    assert.equal(fetched, 2);
    assert.equal(closed, true);
  } finally { await registry.close(); }
});

test('read budget counts the actual UTF-8 response and space for truncation metadata', async () => {
  const row = { payload: 'a'.repeat(800) + '中"\\\n'.repeat(40) };
  const first = { rows: [row], truncated: false };
  const partial = { rows: [row], truncated: true, reason: 'response_bytes' };
  const bytes = (data: unknown) => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] }));
  const next = { payload: 'next'.repeat(50) };
  for (const [items, budget, expected] of [
    [[row], bytes(first), first],
    [[row, next], bytes(partial), partial],
    [[row, next], bytes(first), { ...partial, rows: [] }],
  ] as const) {
    const input = mysqlConfig();
    const config = parseV2Config({ ...input, sources: [{ ...input.sources[0], budgets: { maxResponseBytes: budget, maxItemBytes: budget } }] });
    const registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: async () => {},
      read: async function* () { yield* items; },
    }));
    await registry.initialize();
    try {
      const result = await new Dispatcher(registry).call('mysql_select', { sourceId: 'db1', table: 'reports' });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
    } finally { await registry.close(); }
  }
});

test('unsafe JSON integers are rejected before SQL or BSON filtering with a redacted argument path', async () => {
  const base = mysqlConfig();
  base.sources[0].access.columns.reports.push('private_fixture_field');
  const config = parseV2Config({ ...base, sources: [...base.sources, {
    id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:TEST_MONGO_URI',
    tls: { mode: 'disabled' }, access: {},
  }] });
  const plans: unknown[] = [];
  const registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: async () => {},
    read: async function* (plan) { plans.push(plan.filter); yield { visible: true }; },
  }));
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const sql = JSON.parse('{"sourceId":"db1","table":"reports","where":{"private_fixture_field":9007199254740993}}');
    const mongo = JSON.parse('{"sourceId":"mongo","collection":"reports","filter":{"_id":-9007199254740993}}');
    for (const [tool, args, path] of [['mysql_select', sql, '$.where.*'], ['mongodb_find_one', mongo, '$.filter.*']] as const) {
      const result = await dispatcher.call(tool, args);
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.content[0].text, /private_fixture_field|900719925474099/);
      const { error } = JSON.parse(result.content[0].text);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { path, reason: 'UNSAFE_INTEGER' });
    }
    assert.equal(plans.length, 0);
    assert.equal((await dispatcher.call('mysql_select', { sourceId: 'db1', table: 'reports', where: { id: Number.MAX_SAFE_INTEGER } })).isError, undefined);
    assert.equal((await dispatcher.call('mongodb_find', { sourceId: 'mongo', collection: 'reports', filter: { value: -1.25 } })).isError, undefined);
    assert.deepEqual(plans, [{ id: Number.MAX_SAFE_INTEGER }, { value: -1.25 }]);
  } finally { await registry.close(); }
});

test('write scalar schemas reject unsafe integers in keys and values', () => {
  const mysql = definitions.find(tool => tool.name === 'mysql_prepare_write')!.schema;
  const mongo = definitions.find(tool => tool.name === 'mongodb_prepare_write')!.schema;
  const sql = { sourceId: 'db1', table: 'reports', action: 'insert', key: { id: 1 }, values: { id: Number.MAX_SAFE_INTEGER } };
  const document = { sourceId: 'mongo', collection: 'reports', action: 'insert', key: { _id: Number.MIN_SAFE_INTEGER }, values: { value: 1.25 } };
  const outOfRange = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(mysql.safeParse(sql).success, true);
  assert.equal(mongo.safeParse(document).success, true);
  assert.equal(mysql.safeParse({ ...sql, key: { id: outOfRange } }).success, false);
  assert.equal(mysql.safeParse({ ...sql, values: { id: outOfRange } }).success, false);
  assert.equal(mongo.safeParse({ ...document, key: { _id: -outOfRange } }).success, false);
  assert.equal(mongo.safeParse({ ...document, values: { value: outOfRange } }).success, false);
});

test('required source failures are sanitized and close already opened adapters', async () => {
  const input = mysqlConfig();
  input.sources.push({ ...structuredClone(input.sources[0]), id: 'db2' });
  let closed = 0;
  const registry = new SourceRegistry(parseV2Config(input), async source => ({
    connect: async () => { if (source.id === 'db2') throw new Error('password=private-value'); },
    close: async () => { closed++; }, read: async function* () {},
  }));
  await assert.rejects(registry.initialize(), error => {
    assert.ok(!String(error).includes('private-value')); return true;
  });
  assert.equal(closed, 2);
});

test('MongoDB accepts a remote read-only source with explicit TLS disabled and rejects URI overrides', () => {
  const config = parseV2Config({ version: 2, instance: { ...mysqlConfig().instance, environment: 'production' }, sources: [{
    id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:MONGO_URI', tls: { mode: 'disabled' },
    access: { tier: 'read_only', collections: ['reports'], fields: { reports: ['name'] } },
  }] });
  const source = config.sources[0];
  assert.equal(source.engine, 'mongodb');
  if (source.engine !== 'mongodb') throw new Error();
  const valid = 'mongodb://reader:test-only@remote.example:27017/test?authSource=test';
  assert.equal(validateMongoURI(valid, source, config), valid);
  for (const uri of [valid + '&tlsInsecure=true', valid + '&tls=false', valid + '&retryWrites=true',
    valid + '&directConnection=false', valid.replace('/test?', '/other?'),
    valid.replace('remote.example:27017', 'remote.example:27017,localhost:27018'), 'mongodb+srv://reader:test-only@example.org/test']) {
    assert.throws(() => validateMongoURI(uri, source, config), /INVALID_CONFIG/);
  }
  const mysqlInput = mysqlConfig();
  mysqlInput.sources[0].tls.mode = 'verify_identity';
  assert.throws(() => parseV2Config(mysqlInput), /INVALID_CONFIG/);
});

test('queue cancellation prevents execution and running cancellation retains real capacity', async () => {
  const limiter = new ConcurrencyLimiter(1, 2);
  const controller = new AbortController();
  let release!: () => void;
  const running = limiter.runCancellable(() => new Promise<void>(resolve => { release = resolve; }), controller.signal, 100);
  await new Promise(resolve => setImmediate(resolve));
  const queuedController = new AbortController();
  let executed = false;
  const queued = limiter.runCancellable(async () => { executed = true; }, queuedController.signal, 100);
  queuedController.abort();
  await assert.rejects(queued, /REQUEST_CANCELLED/);
  controller.abort();
  assert.equal(limiter.snapshot().active, 1);
  assert.equal(limiter.snapshot().queued, 0);
  assert.equal(executed, false);
  release(); await running;
  assert.equal(limiter.snapshot().active, 0);
});

test('dispatcher deadline returns promptly while incomplete adapter cleanup still holds capacity', async () => {
  const input = mysqlConfig();
  (input.sources[0] as any).budgets = { queryTimeoutMs: 20, queueTimeoutMs: 100 };
  let release!: () => void;
  const registry = new SourceRegistry(parseV2Config(input), async () => ({
    connect: async () => {}, close: async () => {}, read: async function* () {
      await new Promise<void>(resolve => { release = resolve; }); yield { id: 1 };
    },
  }));
  await registry.initialize();
  try {
    const result = await new Dispatcher(registry).call('mysql_select', { sourceId: 'db1', table: 'reports' });
    assert.equal(JSON.parse(result.content[0].text).error.code, 'REQUEST_CANCELLED');
    assert.equal(registry.globalLimiter.snapshot().active, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(registry.globalLimiter.snapshot().active, 0);
  } finally { await registry.close(); }
});

test('argument depth, bytes and oversized UTF-8 items fail safely without logging input', async () => {
  const input = mysqlConfig();
  (input.sources[0] as any).budgets = { maxItemBytes: 256 };
  let calls = 0, closed = false;
  const events: unknown[] = [];
  const registry = new SourceRegistry(parseV2Config(input), async () => ({
    connect: async () => {}, close: async () => {}, read: async function* () {
      calls++; try { yield { name: '中'.repeat(1000) }; yield { name: 'unreachable' }; } finally { closed = true; }
    },
  }));
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry, event => events.push(event));
    const result = await dispatcher.call('mysql_select', { sourceId: 'db1', table: 'reports' });
    assert.equal(JSON.parse(result.content[0].text).reason, 'item_bytes');
    assert.equal(closed, true);
    const secret = 'never-log-this';
    const bad = await dispatcher.call('mysql_select', { sourceId: secret, table: 'reports', where: { name: 'x'.repeat(70000) } });
    assert.equal(bad.isError, true);
    let nested: unknown = secret;
    for (let i = 0; i < 10; i++) nested = { next: nested };
    assert.equal((await dispatcher.call('mysql_select', nested)).isError, true);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally { await registry.close(); }
});

test('shutdown racing secret resolution cannot leave a newly created adapter open', async () => {
  let resolve!: (adapter: ReadAdapter) => void;
  let closed = 0, connected = 0;
  const registry = new SourceRegistry(parseV2Config(mysqlConfig()), async () => new Promise<ReadAdapter>(r => { resolve = r; }));
  const initializing = assert.rejects(registry.initialize(), /SERVER_CLOSED/);
  let shutdownFinished = false;
  const closing = registry.close().then(() => { shutdownFinished = true; });
  await new Promise<void>(done => setImmediate(done));
  assert.equal(shutdownFinished, false);
  resolve({ connect: async () => { connected++; }, close: async () => { closed++; }, read: async function* () {} });
  await Promise.all([closing, initializing]);
  assert.equal(connected, 0); assert.equal(closed, 1);
});

test('stdio oversized input and output backlog close instead of buffering indefinitely', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const transport = new BoundedStdioTransport(stdin, stdout, 1024, 1024);
  let closed = false, failed = false;
  transport.onclose = () => { closed = true; };
  transport.onerror = () => { failed = true; };
  await transport.start();
  stdin.write('x'.repeat(1025));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true); assert.equal(failed, true);
  const outputTransport = new BoundedStdioTransport(new PassThrough(), new PassThrough(), 1024, 128);
  await assert.rejects(outputTransport.send({ jsonrpc: '2.0', id: 1, result: { text: 'x'.repeat(200) } }), /BUDGET_EXCEEDED/);
  await assert.rejects(outputTransport.send({ jsonrpc: '2.0', id: 2, result: {} }), /SERVER_CLOSED/);
});

test('MongoDB driver logging stays disabled even when the parent enables debug env', async () => {
  const names = ['MONGODB_LOG_ALL', 'MONGODB_LOG_COMMAND'];
  const previous = names.map(name => process.env[name]);
  try {
    names.forEach(name => { process.env[name] = 'trace'; });
    const config = parseV2Config({ version: 2, instance: mysqlConfig().instance, sources: [{
      id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:MONGO_URI', tls: { mode: 'disabled' },
      access: { tier: 'read_only', collections: ['reports'], fields: { reports: ['name'] } },
    }] });
    const source = config.sources[0]; if (source.engine !== 'mongodb') throw new Error();
    const adapter = new MongoReadAdapter(source, 'mongodb://reader:test-only@localhost:27017/test');
    try { assert.equal((adapter as any).client.mongoLogger, undefined); }
    finally { await adapter.close(); }
  } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
});

test('MongoDB projections remove overlapping child paths without broadening selected fields', async () => {
  for (const [fields, expected] of [
    [['profile', 'profile.name'], { profile: 1, _id: 0 }],
    [['profile.name', 'profile'], { profile: 1, _id: 0 }],
    [['_id.tenant'], { '_id.tenant': 1 }],
    [['profile.name', 'profile.email'], { 'profile.name': 1, 'profile.email': 1, _id: 0 }],
    [['profile', 'profiles.name'], { profile: 1, 'profiles.name': 1, _id: 0 }],
  ] as const) {
    const config = parseV2Config({ version: 2, instance: mysqlConfig().instance, sources: [{
      id: 'mongo', engine: 'mongodb', database: 'test', connectionStringRef: 'env:MONGO_URI', tls: { mode: 'disabled' },
      access: { tier: 'read_only', collections: ['reports'], fields: { reports: [...fields] } },
    }] });
    const source = config.sources[0]; if (source.engine !== 'mongodb') throw new Error();
    const adapter = new MongoReadAdapter(source, 'mongodb://reader:test-only@localhost:27017/test');
    const client = (adapter as any).client;
    let closed = false, actual: unknown;
    client.db = () => ({ collection: () => ({ find: (_filter: unknown, options: { projection: unknown }) => {
      actual = options.projection;
      return { async *[Symbol.asyncIterator]() {}, close: async () => { closed = true; } };
    } }) });
    try {
      for await (const _row of adapter.read({ tool: 'mongodb_find', target: 'reports', fields: [...fields], limit: 1 }, new AbortController().signal)) {}
      assert.deepEqual(actual, expected);
      assert.equal(closed, true);
    } finally { await adapter.close(); }
  }
});

test('Redis write preview stops acquiring commands after cancellation at every await boundary', async () => {
  const source = parseV2Config({ version: 2, instance: { name: 'preview', transport: 'stdio', environment: 'test', tier: 'read_write', journal: { directory: '/tmp/db-mcp-preview-test' } }, sources: [{
    id: 'redis', engine: 'redis', host: 'localhost', username: 'writer', passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' },
    access: { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowReplace: true } },
  }] }).sources[0];
  if (source.engine !== 'redis') throw new Error();
  const methods = ['type', 'strLen', 'getRange', 'pTTL'] as const;
  for (const waiting of methods) {
    const adapter = new RedisReadAdapter(source, 'disposable-not-connected');
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    const calls: string[] = [], values = { type: 'string', strLen: 3, getRange: Buffer.from('old'), pTTL: -1 };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    for (const method of methods) client[method] = async () => {
      calls.push(method);
      if (method === waiting) { entered(); await blocked; }
      return values[method];
    };
    const controller = new AbortController();
    const pending = adapter.writer!.preview({ engine: 'redis', tool: 'redis_prepare_write', sourceId: 'redis', action: 'replace', target: 'dev:one',
      value: 'next', expectedValue: 'old', ttl: { mode: 'keep' }, expectedTtl: { mode: 'persistent' } }, controller.signal);
    try {
      await started; controller.abort(); release();
      await assert.rejects(pending, /REQUEST_CANCELLED/);
      assert.deepEqual(calls, methods.slice(0, methods.indexOf(waiting) + 1));
    } finally { release(); await adapter.close(); }
  }
});
