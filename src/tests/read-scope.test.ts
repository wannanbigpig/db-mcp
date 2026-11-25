import test from 'node:test';
import assert from 'node:assert/strict';
import { parseV2Config, type SourceConfig } from '../config/v2.js';
import { authorize, type ReadPlan } from '../runtime/policy.js';
import { SourceRegistry, type ReadAdapter } from '../runtime/sources.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { catalog, definitions } from '../runtime/tool-catalog.js';

type Engine = SourceConfig['engine'];
const input = (engine: Engine, access: Record<string, unknown> = {}) => ({
  version: 2, instance: { name: 'read-scope', transport: 'stdio', environment: 'test', tier: 'read_only' },
  sources: [{ id: engine, engine, tls: { mode: 'disabled' }, access,
    ...(engine === 'mongodb' ? { database: 'reporting', connectionStringRef: 'env:TEST_MONGO_URI' } :
      { host: '127.0.0.1', username: 'reader', passwordRef: 'env:TEST_PASSWORD', ...(engine === 'mysql' ? { database: 'reporting' } : {}) }),
  }],
});
const scoped = (engine: Engine) => engine === 'mysql' ? { tables: ['reports'], columns: { reports: ['id', 'name'] } } :
  engine === 'mongodb' ? { collections: ['reports'], fields: { reports: ['id', 'name'] } } : { keyPrefixes: ['reports:'] };
const selection = (engine: Engine, target = 'not_prelisted') => engine === 'mysql' ? { tool: 'mysql_select', args: { table: target } } :
  engine === 'mongodb' ? { tool: 'mongodb_find', args: { collection: target } } : { tool: 'redis_get', args: { key: target } };

test('omitting read restrictions defaults every engine to database-wide reads without granting writes', () => {
  for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
    const config = parseV2Config(input(engine)); const source = config.sources[0];
    assert.equal(source.access.readScope, 'database'); assert.equal(config.instance.tier, 'read_only');
    assert.equal(source.access.tier, 'read_only'); assert.equal(source.access.writes, undefined);
    const { tool, args } = selection(engine);
    const plan = authorize(source, tool, args);
    assert.equal(source.engine === 'redis' ? plan.redisKey?.toString() : plan.target, 'not_prelisted');
    assert.equal(plan.fields, undefined);
    if (source.engine === 'mysql') { assert.deepEqual(source.access.tables, []); assert.deepEqual(source.access.columns, {}); }
    else if (source.engine === 'mongodb') { assert.deepEqual(source.access.collections, []); assert.deepEqual(source.access.fields, {}); }
    else { assert.deepEqual(source.access.keyPrefixes, []); assert.equal(source.access.allowKeyspaceScan, false); }
  }
});

test('existing allowlists retain their target and projection restrictions when readScope is omitted', () => {
  for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
    const source = parseV2Config(input(engine, scoped(engine))).sources[0];
    assert.equal(source.access.readScope, 'allowlist');
    const { tool, args } = selection(engine, engine === 'redis' ? 'reports:one' : 'reports');
    const plan = authorize(source, tool, args);
    assert.equal(engine === 'redis' ? plan.redisKey?.toString() : plan.target, engine === 'redis' ? 'reports:one' : 'reports');
    const outside = selection(engine, engine === 'redis' ? 'private:one' : 'private');
    assert.throws(() => authorize(source, outside.tool, outside.args), { code: 'SCOPE_DENIED' });
    if (engine !== 'redis') {
      assert.deepEqual(authorize(source, tool, args).fields, ['id', 'name']);
      assert.throws(() => authorize(source, tool, { ...args, [engine === 'mysql' ? 'columns' : 'fields']: ['password'] }), { code: 'SCOPE_DENIED' });
      assert.throws(() => authorize(source, tool, { ...args, [engine === 'mysql' ? 'where' : 'filter']: { password: 'hidden' } }), { code: 'SCOPE_DENIED' });
    }
  }
  const namedCollection = parseV2Config(input('mongodb', { collections: ['constructor'], fields: { constructor: ['name'] } })).sources[0];
  assert.equal(authorize(namedCollection, 'mongodb_find', { collection: 'constructor' }).target, 'constructor');
});

test('MySQL table allowlists distinguish absent column entries from same-named prototype properties', () => {
  const tables = ['toString', 'hasOwnProperty'];
  const unrestricted = parseV2Config(input('mysql', { tables })).sources[0];
  for (const table of tables) {
    assert.equal(authorize(unrestricted, 'mysql_select', { table }).fields, undefined);
    assert.equal(authorize(unrestricted, 'mysql_describe_table', { table }).fields, undefined);
    assert.deepEqual(authorize(unrestricted, 'mysql_select', { table, columns: ['id'] }).fields, ['id']);
  }
  assert.throws(() => authorize(unrestricted, 'mysql_select', { table: 'valueOf' }), { code: 'SCOPE_DENIED' });

  const restricted = parseV2Config(input('mysql', { tables, columns: { toString: ['id'] } })).sources[0];
  assert.deepEqual(authorize(restricted, 'mysql_select', { table: 'toString' }).fields, ['id']);
  assert.deepEqual(authorize(restricted, 'mysql_describe_table', { table: 'toString' }).fields, ['id']);
  for (const args of [{ columns: ['name'] }, { where: { name: 'report' } }, { orderBy: [{ field: 'name', direction: 'asc' }] }]) {
    assert.throws(() => authorize(restricted, 'mysql_select', { table: 'toString', ...args }), { code: 'SCOPE_DENIED' });
  }
  assert.equal(authorize(restricted, 'mysql_select', { table: 'hasOwnProperty' }).fields, undefined);
});

test('empty old restrictions or invalid scope modes never silently become unrestricted reads', () => {
  for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
    for (const readScope of [null, false, '', 'all', 'admin']) {
      assert.throws(() => parseV2Config(input(engine, { readScope })), { code: 'INVALID_CONFIG' });
    }
    assert.throws(() => parseV2Config(input(engine, { readScope: 'allowlist' })), { code: 'INVALID_CONFIG' });
  }
  for (const access of [{ tables: [] }, { columns: {} }, { tables: [], columns: {} }]) {
    assert.throws(() => parseV2Config(input('mysql', access)), { code: 'INVALID_CONFIG' });
  }
  for (const access of [{ collections: [] }, { fields: {} }, { collections: [], fields: {} }]) {
    assert.throws(() => parseV2Config(input('mongodb', access)), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => parseV2Config(input('redis', { keyPrefixes: [] })), { code: 'INVALID_CONFIG' });
});

test('database scope rejects nonempty existing restrictions instead of ignoring them', () => {
  for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
    assert.throws(() => parseV2Config(input(engine, { ...scoped(engine), readScope: 'database' })), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => parseV2Config(input('mysql', { readScope: 'database', columns: { reports: ['name'] } })), { code: 'INVALID_CONFIG' });
  assert.throws(() => parseV2Config(input('mongodb', { readScope: 'database', fields: { reports: ['name'] } })), { code: 'INVALID_CONFIG' });
});

test('explicit database scope has stable frozen output and roundtrips with normalized empty restrictions', () => {
  for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
    const empty = engine === 'mysql' ? { tables: [], columns: {} } : engine === 'mongodb' ? { collections: [], fields: {} } : { keyPrefixes: [] };
    const config = parseV2Config(input(engine, { ...empty, readScope: 'database' }));
    assert.equal(config.sources[0].access.readScope, 'database'); assert.ok(Object.isFrozen(config.sources[0].access));
    assert.deepEqual(parseV2Config(JSON.parse(JSON.stringify(config))), config);
  }
});

test('Redis default username is available only for read-only sources and cannot grant write access', () => {
  const omitted = input('redis'); Reflect.deleteProperty(omitted.sources[0], 'username');
  const source = parseV2Config(omitted).sources[0]; assert.equal(source.engine, 'redis');
  if (source.engine !== 'redis') throw new Error();
  assert.equal(source.username, 'default'); assert.equal(source.access.tier, 'read_only');
  assert.equal(parseV2Config(input('redis')).sources[0].access.readScope, 'database');
  const writable = input('redis', { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowReplace: true } });
  writable.instance.tier = 'read_write'; Object.assign(writable.instance, { journal: { directory: '/tmp/db-mcp-scope-fixture' } });
  Reflect.deleteProperty(writable.sources[0], 'username');
  assert.throws(() => parseV2Config(writable), { code: 'INVALID_CONFIG' });
  Object.assign(writable.sources[0], { username: 'writer' });
  assert.equal(parseV2Config(writable).sources[0].access.readScope, 'allowlist');
  Object.assign(writable.sources[0], { access: { tier: 'read_write', readScope: 'database', writes: { allowReplace: true } } });
  assert.throws(() => parseV2Config(writable), { code: 'INVALID_CONFIG' });
});

test('database scope still checks target, projection, filter and sort field syntax', () => {
  const mysql = parseV2Config(input('mysql')).sources[0], mongo = parseV2Config(input('mongodb')).sources[0];
  assert.deepEqual(authorize(mysql, 'mysql_select', { table: 'reports', columns: ['id'], where: { name: 'literal' }, orderBy: [{ field: 'id', direction: 'asc' }] }).fields, ['id']);
  assert.deepEqual(authorize(mongo, 'mongodb_find', { collection: 'reports', fields: ['profile.name'], filter: { 'profile.name': 'literal' } }).fields, ['profile.name']);
  for (const args of [{ table: 'other.reports' }, { table: 'reports`' }, { table: 'reports', columns: ['other.password'] },
    { table: 'reports', where: { 'name`': 'x' } }, { table: 'reports', orderBy: [{ field: 'id;DROP', direction: 'asc' }] }]) {
    assert.throws(() => authorize(mysql, 'mysql_select', args), { code: 'SCOPE_DENIED' });
  }
  for (const args of [{ collection: '$cmd' }, { collection: 'reports', fields: ['profile.$where'] },
    { collection: 'reports', fields: ['profile..name'] }, { collection: 'reports', filter: { $where: 'script' } },
    { collection: 'reports', orderBy: [{ field: '__proto__.name', direction: 'asc' }] }]) {
    assert.throws(() => authorize(mongo, 'mongodb_find', args), { code: 'SCOPE_DENIED' });
  }
});

test('database reads keep Redis scan disabled unless opted in and default to the empty prefix only for database scope', () => {
  const closed = parseV2Config(input('redis')).sources[0];
  assert.throws(() => authorize(closed, 'redis_keys', { prefix: '' }), { code: 'SCOPE_DENIED' });
  const open = parseV2Config(input('redis', { allowKeyspaceScan: true })).sources[0];
  assert.equal(authorize(open, 'redis_keys', { prefix: '' }).prefix, '');
  assert.equal(authorize(open, 'redis_keys', {}).prefix, '');
  for (const prefix of ['private:', '*']) assert.throws(() => authorize(open, 'redis_keys', { prefix }), { code: 'SCOPE_DENIED' });
  const list = parseV2Config(input('redis', { keyPrefixes: ['reports:'], allowKeyspaceScan: true })).sources[0];
  assert.equal(authorize(list, 'redis_keys', { prefix: 'reports:' }).prefix, 'reports:');
  assert.throws(() => authorize(list, 'redis_keys', { prefix: '' }), { code: 'SCOPE_DENIED' });
  assert.throws(() => authorize(list, 'redis_keys', {}), { code: 'SCOPE_DENIED' });
});

test('source discovery exposes effective tool choices and only authorized Redis scan prefixes', async () => {
  const base = input('redis');
  const configured = parseV2Config({
    ...base,
    instance: { ...base.instance, tier: 'read_write', journal: { directory: '/tmp/db-mcp-discovery-fixture' } },
    sources: [
      { ...base.sources[0], id: 'report_cache', access: { keyPrefixes: ['reports:'], allowKeyspaceScan: true }, budgets: { maxRows: 20 } },
      { ...base.sources[0], id: 'wide_cache', access: { allowKeyspaceScan: true } },
      { ...base.sources[0], id: 'read_cache', access: { allowKeyspaceScan: true, allowedTools: ['redis_type'] } },
      { ...base.sources[0], id: 'write_cache', access: { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowCreate: true } } },
    ],
  });
  const registry = new SourceRegistry(configured, async () => ({
    connect: async () => {}, close: async () => {}, async *read() {},
  }));
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const reply = await dispatcher.call('list_sources', {});
    assert.equal(reply.isError, undefined);
    const { sources: [reports, wide, read, write] } = JSON.parse(reply.content[0].text);
    assert.deepEqual(reports.scanPrefixes, ['reports:']);
    assert.equal(reports.readScope, 'allowlist');
    assert.equal(reports.maxRows, 20);
    assert.deepEqual(wide.scanPrefixes, ['']);
    assert.equal(wide.readScope, 'database');
    assert.deepEqual(read.enabledTools, ['redis_type']);
    assert.equal(read.scanPrefixes, undefined);
    for (const tool of ['redis_prepare_write', 'commit_write', 'operation_status']) {
      assert.ok(write.enabledTools.includes(tool));
      assert.ok(!read.enabledTools.includes(tool));
    }
    const list = dispatcher.tools().find(tool => tool.name === 'redis_keys')!;
    const { sourceId, prefix } = list.inputSchema.properties!;
    assert.deepEqual(sourceId && (sourceId as { enum?: string[] }).enum, ['report_cache', 'wide_cache']);
    assert.ok(prefix && !Object.hasOwn(prefix, 'default'));
    const prepare = dispatcher.tools().find(tool => tool.name === 'redis_prepare_write')!;
    assert.deepEqual((prepare.inputSchema.properties!.sourceId as { enum?: string[] }).enum, ['write_cache']);

    for (const args of [{}, { prefix: 'PRIVATE_PREFIX' }]) {
      const denied = await dispatcher.call('redis_keys', { sourceId: 'report_cache', ...args });
      assert.equal(denied.isError, true);
      const text = denied.content[0].text;
      const { error } = JSON.parse(text);
      assert.equal(error.code, 'SCOPE_DENIED');
      assert.deepEqual(error.details, { reason: 'scan_prefix_denied', path: '$.prefix', nextAction: 'check_scan_prefixes' });
      assert.match(error.message, /list_sources.*scanPrefixes/);
      assert.doesNotMatch(text, /reports:|PRIVATE_PREFIX/);
    }
    const hiddenScan = await dispatcher.call('redis_keys', { sourceId: 'read_cache' });
    assert.equal(JSON.parse(hiddenScan.content[0].text).error.details, undefined);
  } finally { await registry.close(); }
});

test('MongoDB selector schemas publish the authorized identifier grammar', () => {
  const valid = { sourceId: 'mongodb', collection: 'report-v2.2026', fields: ['profile.parent_name'],
    filter: { 'profile.parent_name': 'sample' } };
  const source = parseV2Config(input('mongodb')).sources[0];
  const find = definitions.find(tool => tool.name === 'mongodb_find')!;
  assert.equal(find.schema.safeParse(valid).success, true);
  assert.equal(authorize(source, 'mongodb_find', valid).target, valid.collection);
  for (const args of [{ collection: '月报' }, { fields: ['profile..name'] }, { filter: { 'profile.constructor.slug': 'sample' } },
    { orderBy: [{ field: 'profile.0.name', direction: 'asc' }] }]) {
    const supplied = { ...valid, ...args };
    assert.equal(find.schema.safeParse(supplied).success, true);
    assert.throws(() => authorize(source, 'mongodb_find', supplied), { code: 'SCOPE_DENIED' });
  }
  const schema = catalog([source]).find(tool => tool.name === 'mongodb_find')!.inputSchema;
  const { collection, fields, filter } = schema.properties as {
    collection: { pattern: string }; fields: { items: { pattern: string } }; filter: { propertyNames: { pattern: string } };
  };
  assert.ok(new RegExp(collection.pattern).test(valid.collection));
  assert.ok(!new RegExp(collection.pattern).test('月报'));
  for (const pattern of [fields.items.pattern, filter.propertyNames.pattern]) {
    assert.ok(new RegExp(pattern).test('profile.parent_name'));
    assert.ok(!new RegExp(pattern).test('profile.constructor.slug'));
  }
});

test('source discovery fits maximum configured names and JSON-escaped scan prefixes', async () => {
  const base = input('redis');
  const prefixes = Array.from({ length: 16 }, (_, index) => '"'.repeat(127) + index.toString(16));
  const configured = parseV2Config({
    ...base,
    instance: { ...base.instance, tier: 'read_write', journal: { directory: '/tmp/db-mcp-discovery-fixture' },
      budgets: { maxSources: 16, maxConnections: 32 } },
    sources: Array.from({ length: 16 }, (_, index) => ({
      ...base.sources[0], id: 'r'.repeat(63) + index.toString(16), purpose: '\0'.repeat(200), required: false,
      access: { tier: 'read_write', keyPrefixes: prefixes, allowKeyspaceScan: true, writes: { allowCreate: true } },
      budgets: { maxConcurrent: 1, maxRows: 1000 },
    })),
  });
  const registry = new SourceRegistry(configured, async () => ({
    connect: async () => { throw new Error('fixture connection unavailable'); }, close: async () => {}, async *read() {},
  }));
  await registry.initialize();
  try {
    const result = await new Dispatcher(registry).call('list_sources', {});
    assert.equal(result.isError, undefined);
    const { sources } = JSON.parse(result.content[0].text);
    assert.equal(sources.length, 16);
    for (const source of sources) {
      assert.equal(source.status, 'unavailable');
      assert.equal(source.purpose, '\0'.repeat(200));
      assert.deepEqual(source.scanPrefixes, prefixes);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 160 * 1024);
  } finally { await registry.close(); }
});

test('Redis range offsets published to clients accept any non-negative safe integer', () => {
  const source = parseV2Config(input('redis')).sources[0];
  const tool = definitions.find(tool => tool.name === 'redis_get_range')!;
  const args = { sourceId: source.id, key: 'reports:long' };
  assert.equal(tool.schema.safeParse({ ...args, offset: 2 ** 30 + 1 }).success, true);
  assert.equal(tool.schema.safeParse({ ...args, offset: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  const schema = catalog([source]).find(entry => entry.name === tool.name)!.inputSchema;
  assert.equal((schema.properties!.offset as { maximum: number }).maximum, Number.MAX_SAFE_INTEGER);
});

test('Redis exact reads authorize key bytes and accept reversible representations', () => {
  const database = parseV2Config(input('redis')).sources[0];
  const scope = parseV2Config(input('redis', { keyPrefixes: ['报告:'] })).sources[0];
  const key = Buffer.concat([Buffer.from('报告:'), Buffer.from([0xff])]);
  assert.deepEqual(authorize(scope, 'redis_type', { key: { base64: key.toString('base64') } }).redisKey, key);
  assert.throws(() => authorize(scope, 'redis_type', { key: { base64: Buffer.from('其他:').toString('base64') } }), { code: 'SCOPE_DENIED' });
  assert.deepEqual(authorize(database, 'redis_type', { key: '' }).redisKey, Buffer.alloc(0));
  assert.deepEqual(authorize(database, 'redis_type', { key: 'a'.repeat(525) }).redisKey, Buffer.alloc(525, 'a'));
  assert.throws(() => authorize(database, 'redis_type', { key: { base64: '/x==' } }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => authorize(database, 'redis_type', { key: '\ud800' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => authorize(database, 'redis_type', { key: 'a'.repeat(4097) }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseV2Config(input('redis', { keyPrefixes: ['x\ud800'] })), { code: 'INVALID_CONFIG' });
});

test('table discovery remains subject to tool authorization in both read scopes', () => {
  for (const access of [{}, scoped('mysql')]) {
    const source = parseV2Config(input('mysql', access)).sources[0];
    assert.equal(authorize(source, 'mysql_list_tables', {}).tool, 'mysql_list_tables');
    const denied = parseV2Config(input('mysql', { ...access, allowedTools: ['mysql_select'] })).sources[0];
    assert.throws(() => authorize(denied, 'mysql_list_tables', {}), { code: 'SCOPE_DENIED' });
  }
});

test('database-wide read-only sources deny forged writes and cross-database or script arguments before adapters', async () => {
  let reads = 0, previews = 0, writes = 0; const plans: ReadPlan[] = [];
  const all = input('mysql'); all.sources.push(input('redis').sources[0], input('mongodb').sources[0]);
  const registry = new SourceRegistry(parseV2Config(all), async () => ({ connect: async () => {}, close: async () => {},
    read: async function* (plan) { reads++; plans.push(plan); yield { value: 'visible' }; },
    writer: { preview: async () => { previews++; return { fingerprint: 'unused', condition: 'match' }; },
      write: async () => { writes++; return { state: 'success', directAffected: 1 }; } },
  } satisfies ReadAdapter));
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    for (const [name, args, code] of [
      ['mysql_prepare_write', { sourceId: 'mysql' }, 'SCOPE_DENIED'], ['mongodb_prepare_write', { sourceId: 'mongodb' }, 'SCOPE_DENIED'],
      ['redis_prepare_write', { sourceId: 'redis' }, 'SCOPE_DENIED'], ['commit_write', { sourceId: 'mysql' }, 'SCOPE_DENIED'],
      ['mysql_query', { sourceId: 'mysql', sql: 'DELETE FROM reporting.reports' }, 'SCOPE_DENIED'],
      ['redis_eval', { sourceId: 'redis', script: 'return redis.call("SET","key","value")' }, 'SCOPE_DENIED'],
      ['mysql_select', { sourceId: 'mysql', table: 'reports', database: 'other' }, 'INVALID_ARGUMENT'],
      ['mongodb_find', { sourceId: 'mongodb', collection: 'reports', database: 'other' }, 'INVALID_ARGUMENT'],
      ['mongodb_find', { sourceId: 'mongodb', collection: 'reports', filter: { name: { $ne: 'x' } } }, 'INVALID_ARGUMENT'],
      ['redis_get', { sourceId: 'redis', key: 'any', database: 4 }, 'INVALID_ARGUMENT'],
      ['mysql_select', { sourceId: 'not-configured', table: 'reports' }, 'SCOPE_DENIED'],
    ] as const) {
      const result = await dispatcher.call(name, args); assert.equal(result.isError, true, name);
      assert.equal(JSON.parse(result.content[0].text).error.code, code, name);
    }
    assert.equal(reads, 0); assert.equal(previews, 0); assert.equal(writes, 0);
    for (const engine of ['mysql', 'mongodb', 'redis'] as const) {
      const { tool, args } = selection(engine);
      assert.equal((await dispatcher.call(tool, { sourceId: engine, ...args })).isError, undefined);
    }
    assert.equal(reads, 3); assert.equal(previews, 0); assert.equal(writes, 0);
    assert.ok(plans.every(plan => !Object.hasOwn(plan, 'database')));
  } finally { await registry.close(); }
});
