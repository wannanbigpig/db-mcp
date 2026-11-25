import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, rename, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseV2Config } from '../config/v2.js';
import { OperationJournal } from '../runtime/journal.js';
import { authorizeWrite } from '../runtime/write-policy.js';
import { SourceRegistry } from '../runtime/sources.js';
import { Operations } from '../runtime/operations.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import type { WriteAdapter, WriteOutcome } from '../runtime/write-policy.js';
import { RedisReadAdapter, validateMongoURI } from '../runtime/adapters.js';
import { catalog, definitions } from '../runtime/tool-catalog.js';
import { versionOf } from '../runtime/adapters/shared.js';

const configuration = (directory: string, environment = 'test') => ({
  version: 2, instance: { name: 'writer', transport: 'stdio', environment, tier: 'read_write',
    journal: { directory } }, sources: [{ id: 'mysql', engine: 'mysql', host: 'localhost', database: 'test',
    username: 'writer', passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' },
    access: { tier: 'read_write', tables: ['items'], columns: { items: ['tenant', 'id', 'version', 'name'] },
      writes: { metadataGuard: 'mcp_write_metadata', tables: { items: { keyColumns: ['tenant', 'id'],
        versionColumn: 'version', writableColumns: ['name'], allowInsert: true, allowUpdate: true } } } } }],
});

test('durable write previews are additive, non-idempotent tools for all three engines', () => {
  const base = configuration('/tmp/db-mcp-preview-annotations');
  const config = parseV2Config({ ...base, instance: { ...base.instance, budgets: { maxConnections: 16 } }, sources: [
    base.sources[0],
    { id: 'redis', engine: 'redis', host: 'localhost', username: 'writer', passwordRef: 'env:UNUSED_FIXTURE', tls: { mode: 'disabled' },
      access: { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowCreate: true } } },
    { id: 'mongodb', engine: 'mongodb', database: 'test', connectionStringRef: 'env:UNUSED_FIXTURE', tls: { mode: 'disabled' },
      access: { tier: 'read_write', collections: ['items'], fields: { items: ['_id', 'version', 'name'] },
        writes: { collections: { items: { versionColumn: 'version', writableColumns: ['name'], allowUpdate: true } } } } },
  ] });
  const tools = catalog(config.sources);
  for (const engine of ['mysql', 'redis', 'mongodb']) assert.deepEqual(tools.find(tool => tool.name === engine + '_prepare_write')?.annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(tools.find(tool => tool.name === 'mysql_select')?.annotations,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tools.find(tool => tool.name === 'operation_status')?.annotations,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tools.find(tool => tool.name === 'commit_write')?.annotations,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
});

test('write profile is non-production, explicit, precise and never grants delete implicitly', () => {
  const config = parseV2Config(configuration('/tmp/db-mcp-journal-test'));
  assert.throws(() => parseV2Config(configuration('/tmp/db-mcp-journal-test', 'production')));
  const missingJournal = configuration('/tmp/db-mcp-journal-test');
  Reflect.deleteProperty(missingJournal.instance, 'journal'); assert.throws(() => parseV2Config(missingJournal));
  const unsafeName = configuration('/tmp/db-mcp-journal-test');
  unsafeName.sources[0].access.writes.tables.items.versionColumn = 'constructor'; assert.throws(() => parseV2Config(unsafeName));
  const source = config.sources[0];
  const args = { sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'next' } };
  assert.equal(authorizeWrite(source, 'mysql_prepare_write', args).action, 'update');
  for (const change of [{ key: { id: 2 } }, { key: { tenant: null, id: 2 } }, { action: 'delete', values: undefined },
    { values: { version: 9 } }, { table: 'hidden' }, { values: { name: 'next', id: 3 } }]) {
    assert.throws(() => authorizeWrite(source, 'mysql_prepare_write', { ...args, ...change }));
  }
});

test('write-enabled sources still require TLS for non-loopback targets', () => {
  const input = configuration('/tmp/db-mcp-remote-writer-test');
  const mysql = { ...input.sources[0], host: 'remote.example' };
  const redis = { id: 'redis', engine: 'redis', host: 'remote.example', username: 'writer', passwordRef: 'env:TEST_PASSWORD',
    tls: { mode: 'disabled' }, access: { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowCreate: true } } };
  for (const source of [mysql, redis]) {
    assert.throws(() => parseV2Config({ ...input, sources: [source] }), {
      diagnostics: [{ path: '$.sources[0].tls.mode', reason: 'TLS_REQUIRED' }],
    });
  }
  const config = parseV2Config({ ...input, sources: [{
    id: 'mongodb', engine: 'mongodb', database: 'test', connectionStringRef: 'env:TEST_URI', tls: { mode: 'disabled' },
    access: { tier: 'read_write', collections: ['items'], fields: { items: ['_id', 'version', 'name'] },
      writes: { collections: { items: { versionColumn: 'version', writableColumns: ['name'], allowUpdate: true } } } },
  }] });
  const source = config.sources[0];
  assert.equal(source.engine, 'mongodb');
  assert.throws(() => validateMongoURI('mongodb://writer:fixture@remote.example/test', source, config), { code: 'INVALID_CONFIG' });
});

test('the maximum safe integer version is valid for compare-and-delete', () => {
  const input = configuration('/tmp/db-mcp-max-version-test');
  const table = input.sources[0].access.writes.tables.items;
  Object.assign(table, { allowDelete: true });
  const source = parseV2Config(input).sources[0];
  const tool = definitions.find(definition => definition.name === 'mysql_prepare_write')!;
  const request = { sourceId: 'mysql', table: 'items', action: 'delete', key: { tenant: 1, id: 2 }, expectedVersion: Number.MAX_SAFE_INTEGER };
  const parsed = tool.schema.parse(request);
  const plan = authorizeWrite(source, tool.name, parsed);
  assert.equal(plan.engine, 'mysql');
  assert.equal(plan.expectedVersion, Number.MAX_SAFE_INTEGER);
  assert.equal(versionOf(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(tool.schema.safeParse({ ...request, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.throws(() => versionOf('9007199254740992'), { code: 'SCHEMA_UNSAFE' });
});

test('incomplete write opt-in and contradictory read-only configuration fail closed', () => {
  for (const change of [
    (input: ReturnType<typeof configuration>) => Reflect.deleteProperty(input.instance, 'tier'),
    (input: ReturnType<typeof configuration>) => Reflect.deleteProperty(input.sources[0].access, 'tier'),
    (input: ReturnType<typeof configuration>) => Reflect.deleteProperty(input.instance, 'journal'),
    (input: ReturnType<typeof configuration>) => Reflect.deleteProperty(input.sources[0].access, 'writes'),
    (input: ReturnType<typeof configuration>) => { input.instance.tier = 'read_only'; },
    (input: ReturnType<typeof configuration>) => { input.sources[0].access.tier = 'read_only'; },
    (input: ReturnType<typeof configuration>) => { input.instance.tier = 'read_only'; Reflect.deleteProperty(input.instance, 'journal'); },
    (input: ReturnType<typeof configuration>) => { Reflect.deleteProperty(input.instance, 'tier'); Reflect.deleteProperty(input.instance, 'journal'); },
  ]) {
    const input = configuration('/tmp/db-mcp-explicit-write-test'); change(input);
    assert.throws(() => parseV2Config(input), { code: 'INVALID_CONFIG' });
  }
});

for (const explicit of [true, false]) test('read-write instance cannot write through a ' +
  (explicit ? 'read-only' : 'default read-only') + ' source even when the adapter can write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-app-read-only-'));
  const input = configuration(dir); Reflect.deleteProperty(input.sources[0].access, 'writes');
  if (explicit) input.sources[0].access.tier = 'read_only';
  else Reflect.deleteProperty(input.sources[0].access, 'tier');
  let registry: SourceRegistry | undefined, operations: Operations | undefined;
  let previews = 0, writes = 0, reads = 0;
  try {
    const config = parseV2Config(input); assert.equal(config.instance.tier, 'read_write'); assert.equal(config.sources[0].access.tier, 'read_only');
    registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: async () => {},
      read: async function* () { reads++; yield { id: 2, name: 'visible' }; },
      writer: { preview: async () => { previews++; return { fingerprint: 'fixed', condition: 'match' }; },
        write: async (_plan, _fingerprint, _signal, hooks) => { hooks.sent(); writes++; return { state: 'success', directAffected: 1 }; } },
    }));
    await registry.initialize();
    const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
    operations = new Operations(registry, journal);
    const dispatcher = new Dispatcher(registry, () => {}, operations);
    const args = { sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'next' } };
    // Seed a real record through the trusted journal to prove denial is not just
    // a missing ID or hidden tool. Application policy must stop a capable writer.
    const record = await journal.prepare('mysql', 'mysql_prepare_write');
    const signal = new AbortController().signal;
    await assert.rejects(operations.prepare('mysql_prepare_write', args, signal), { code: 'SCOPE_DENIED' });
    assert.throws(() => operations!.commit('mysql', record.operationId, signal), { code: 'SCOPE_DENIED' });
    assert.throws(() => operations!.status('mysql', record.operationId), { code: 'SCOPE_DENIED' });
    const names = dispatcher.tools().map(tool => tool.name);
    for (const [name, params] of [['mysql_prepare_write', args], ['commit_write', { sourceId: 'mysql', operationId: record.operationId }],
      ['operation_status', { sourceId: 'mysql', operationId: record.operationId }]] as const) {
      assert.equal(names.includes(name), false);
      const denied = await dispatcher.call(name, params); assert.equal(denied.isError, true);
      assert.equal(JSON.parse(denied.content[0].text).error.code, 'SCOPE_DENIED');
    }
    const result = await dispatcher.call('mysql_select', { sourceId: 'mysql', table: 'items', columns: ['id','name'], limit: 1 });
    assert.equal(result.isError, undefined); assert.deepEqual(JSON.parse(result.content[0].text).rows, [{ id: 2, name: 'visible' }]);
    assert.equal(reads, 1); assert.equal(previews, 0); assert.equal(writes, 0); assert.equal(journal.get(record.operationId)?.state, 'prepared');
  } finally {
    if (operations) await operations.stop(); else await registry?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('each engine independently opts into one write action without granting the other actions', () => {
  for (const engine of ['mysql','mongodb','redis'] as const) {
    const actions = engine === 'redis' ? ['create','replace','delete'] as const : ['insert','update','delete'] as const;
    for (const enabled of actions) {
      const common = configuration('/tmp/db-mcp-action-test');
      const objectPolicy = { versionColumn: 'version', writableColumns: ['name'],
        [enabled === 'insert' ? 'allowInsert' : enabled === 'update' ? 'allowUpdate' : 'allowDelete']: true };
      const source = engine === 'mysql' ? { ...common.sources[0], access: { ...common.sources[0].access,
        writes: { metadataGuard: 'mcp_write_metadata', tables: { items: { ...objectPolicy, keyColumns: ['tenant','id'] } } } } } :
        engine === 'mongodb' ? { id: 'mongo', engine, database: 'test', connectionStringRef: 'env:TEST_MONGO_URI', tls: { mode: 'disabled' },
          access: { tier: 'read_write', collections: ['items'], fields: { items: ['_id','version','name'] }, writes: { collections: { items: objectPolicy } } } } :
          { id: 'cache', engine, host: 'localhost', username: 'writer', passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' },
            access: { tier: 'read_write', keyPrefixes: ['dev:'],
              writes: { [enabled === 'create' ? 'allowCreate' : enabled === 'replace' ? 'allowReplace' : 'allowDelete']: true } } };
      const parsed = parseV2Config({ ...common, sources: [source] }).sources[0];
      const tool = engine + '_prepare_write';
      for (const action of actions) {
        const input = engine === 'redis' ? { sourceId: parsed.id, key: 'dev:one', action,
          ...(action !== 'delete' ? { value: 'next', ttl: { mode: action === 'create' ? 'clear' : 'keep' } } : {}),
          ...(action !== 'create' ? { expectedValue: 'old', expectedTtl: { mode: 'persistent' } } : {}) } :
          { sourceId: parsed.id, [engine === 'mysql' ? 'table' : 'collection']: 'items', action,
            key: engine === 'mysql' ? { tenant: 1, id: 2 } : { _id: 'one' },
            ...(action !== 'insert' ? { expectedVersion: 0 } : {}), ...(action !== 'delete' ? { values: { name: 'next' } } : {}) };
        if (action === enabled) assert.equal(authorizeWrite(parsed, tool, input).action, action);
        else assert.throws(() => authorizeWrite(parsed, tool, input), { code: 'SCOPE_DENIED' });
      }
    }
  }
});

test('Redis preview never uses unbounded GET after a racy STRLEN observation', async () => {
  const source = parseV2Config({ version: 2, instance: { name: 'writer', transport: 'stdio', environment: 'test', tier: 'read_write', journal: { directory: '/tmp/db-mcp-test' } }, sources: [
    { id: 'cache', engine: 'redis', host: 'localhost', username: 'writer', passwordRef: 'env:TEST_PASSWORD', tls: { mode: 'disabled' },
      access: { tier: 'read_write', keyPrefixes: ['dev:'], writes: { allowReplace: true } } },
  ] }).sources[0];
  assert.equal(source.engine, 'redis'); if (source.engine !== 'redis') return;
  const adapter = new RedisReadAdapter(source, 'disposable-not-connected');
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  client.type = async () => 'string'; client.strLen = async () => 4;
  client.get = async () => { throw new Error('UNSAFE_FULL_GET'); };
  client.getRange = async (_options: unknown, _key: string, start: number, end: number) => {
    assert.equal(start, 0); assert.equal(end, 4096); return Buffer.alloc(4097);
  };
  await assert.rejects(adapter.writer!.preview({ engine: 'redis', tool: 'redis_prepare_write', sourceId: 'cache', action: 'replace', target: 'dev:one',
    value: 'next', expectedValue: 'old', ttl: { mode: 'keep' }, expectedTtl: { mode: 'persistent' } }, new AbortController().signal), /BUDGET_EXCEEDED/);
  await adapter.close();
});

test('journal is exclusive, bounded, redacted and recovers pending as unknown without replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-journal-'));
  try {
    const options = { directory: dir, maxOperations: 2, retentionDays: 7, previewTtlMs: 60000, maxPrepared: 2 };
    const journal = await OperationJournal.open(options, 'writer');
    await assert.rejects(OperationJournal.open(options, 'writer'));
    const prepared = await journal.prepare('mysql', 'mysql_prepare_write');
    await journal.pending(prepared.operationId);
    const other = await journal.prepare('mysql', 'mysql_prepare_write');
    await assert.rejects(journal.prepare('mysql', 'mysql_prepare_write'));
    await journal.finish(other.operationId, { state: 'success', directAffected: 1 });
    assert.ok(!(await readFile(path.join(dir, 'operations.json'), 'utf8')).includes('values'));
    await journal.close();
    const recovered = await OperationJournal.open(options, 'writer');
    assert.equal(recovered.get(prepared.operationId)?.state, 'unknown_outcome');
    assert.equal(recovered.get(other.operationId)?.state, 'success');
    await recovered.close();
    await chmod(dir, 0o755);
    await assert.rejects(OperationJournal.open(options, 'writer'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function fixture(writer: WriteAdapter, timeout = 1000, journalLimits?: { maxPrepared: number; maxOperations: number; previewTtlMs?: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-operations-'));
  const input = configuration(dir); Object.assign(input.sources[0], { budgets: { queryTimeoutMs: timeout, maxConcurrent: 1 } });
  Object.assign(input.instance, { budgets: { maxConcurrent: 1 } });
  Object.assign(input.instance.journal, journalLimits);
  const config = parseV2Config(input);
  const registry = new SourceRegistry(config, async () => ({ connect: async () => {}, close: async () => {}, read: async function* () {}, writer }));
  await registry.initialize();
  const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
  const operations = new Operations(registry, journal);
  const dispatcher = new Dispatcher(registry, () => {}, operations);
  const prepare = async () => {
    const result = await dispatcher.call('mysql_prepare_write', { sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'secret-test-value' } });
    const data = JSON.parse(result.content[0].text); assert.ok(data.operationId); return data.operationId as string;
  };
  return { dir, registry, operations, dispatcher, prepare, cleanup: async () => { await operations.stop(); await rm(dir, { recursive: true, force: true }); } };
}

function pauseSnapshot(journal: OperationJournal, skip = 0, fail = false) {
  const storage = journal as unknown as { persist(...args: unknown[]): Promise<void> };
  const persist = storage.persist;
  let started!: () => void, resume!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  storage.persist = async function (...args) {
    if (skip-- === 0) {
      storage.persist = persist;
      started(); await paused;
      if (fail) throw new Error('simulated snapshot failure');
    }
    return persist.apply(this, args);
  };
  return { saving, resume };
}

test('cancelled write preview discards its unissued operation even during journal persistence', { timeout: 10000 }, async () => {
  const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }),
    write: async () => { throw new Error('No write is expected'); } }, 5000, { maxPrepared: 1, maxOperations: 1 });
  const save = pauseSnapshot(f.operations.journal);
  try {
    const controller = new AbortController();
    const preview = f.dispatcher.call('mysql_prepare_write', {
      sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'next' },
    }, controller.signal);
    await save.saving;
    controller.abort();
    save.resume();
    const result = await preview;
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'REQUEST_CANCELLED');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'operations.json'), 'utf8')).records, []);
    await f.prepare();
  } finally { save.resume(); await f.cleanup(); }
});

test('cancelled preview cleanup removes an unissued reservation already expired by another prepare', { timeout: 10000 }, async t => {
  let previews = 0, nextPreviewed = () => {};
  const nextPreview = new Promise<void>(resolve => { nextPreviewed = resolve; });
  const f = await fixture({
    preview: async () => {
      if (++previews === 2) nextPreviewed();
      return { fingerprint: 'fixed', condition: 'match' };
    },
    write: async () => { throw new Error('No write is expected'); },
  }, 5000, { maxPrepared: 2, maxOperations: 2, previewTtlMs: 1000 });
  const save = pauseSnapshot(f.operations.journal);
  try {
    const controller = new AbortController();
    const abandoned = f.dispatcher.call('mysql_prepare_write', {
      sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'abandoned' },
    }, controller.signal);
    await save.saving;
    const afterExpiry = Date.now() + 1001;
    t.mock.method(Date, 'now', () => afterExpiry);
    const fresh = f.prepare();
    await nextPreview;
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    save.resume();
    const result = await abandoned;
    assert.equal(JSON.parse(result.content[0].text).error.code, 'REQUEST_CANCELLED');
    const records = JSON.parse(await readFile(path.join(f.dir, 'operations.json'), 'utf8')).records;
    assert.deepEqual(records.map((r: { operationId: string }) => r.operationId), [await fresh]);
    await f.prepare();
  } finally { save.resume(); await f.cleanup(); }
});

for (const fail of [false, true]) test('status and duplicate commit wait for durable confirmation' + (fail ? ' when final persistence fails' : ''),
  { timeout: 10000 }, async () => {
    const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }),
      write: async (_plan, _fingerprint, _signal, hooks) => { hooks.sent(); return { state: 'success', directAffected: 1 }; } }, 5000);
    let resume = () => {};
    try {
      const operationId = await f.prepare(), args = { sourceId: 'mysql', operationId };
      const finalSave = pauseSnapshot(f.operations.journal, 1, fail); resume = finalSave.resume;
      const committed = f.dispatcher.call('commit_write', args);
      await finalSave.saving;
      const status = JSON.parse((await f.dispatcher.call('operation_status', args)).content[0].text);
      assert.equal(status.state, 'pending'); assert.equal(status.journalDegraded, undefined);
      let replied = false;
      const duplicate = f.dispatcher.call('commit_write', args).then(result => { replied = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(replied, false);

      resume();
      for (const result of await Promise.all([committed, duplicate, committed.then(() => f.dispatcher.call('operation_status', args))])) {
        const outcome = JSON.parse(result.content[0].text);
        assert.equal(outcome.state, 'success'); assert.equal(outcome.directAffected, 1);
        assert.equal(outcome.journalDegraded, fail ? true : undefined);
      }
      assert.equal(f.operations.journal.get(operationId)?.state, fail ? 'pending' : 'success');
      const diskState = JSON.parse(await readFile(path.join(f.dir, 'operations.json'), 'utf8')).records[0].state;
      assert.equal(diskState, fail ? 'pending' : 'success');
    } finally { resume(); await f.cleanup(); }
  });

test('concurrent commits execute once; uncertainty blocks while saving and late success must be durable', { timeout: 10000 }, async () => {
  let writes = 0, complete: (result: WriteOutcome) => void = () => {};
  let entered: () => void = () => {};
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }),
    write: async (_plan, _fp, _signal, hooks) => { writes++; hooks.sent(); entered(); return new Promise(resolve => { complete = resolve; }); } }, 5000);
  let resume = () => {};
  try {
    const id = await f.prepare();
    assert.equal((await f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id, values: { name: 'tamper' } })).isError, true);
    const controller = new AbortController();
    const calls = Promise.all([1, 2].map(() => f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id }, controller.signal)));
    await sent;
    const unknownSave = pauseSnapshot(f.operations.journal); resume = unknownSave.resume;
    controller.abort(); await unknownSave.saving;
    assert.equal(f.operations.status('mysql', id).state, 'pending');
    assert.deepEqual(f.operations.blockedSources(), ['mysql']);
    resume();
    const results = await calls;
    assert.equal(writes, 1);
    assert.equal(JSON.parse(results[0].content[0].text).state, 'unknown_outcome');
    assert.equal(f.registry.globalLimiter.snapshot().active, 1);
    const denied = await f.dispatcher.call('mysql_prepare_write', { sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'new-attempt' } });
    assert.equal(JSON.parse(denied.content[0].text).error.code, 'WRITE_OUTCOME_UNKNOWN');
    const confirmationSave = pauseSnapshot(f.operations.journal); resume = confirmationSave.resume;
    complete({ state: 'success', directAffected: 1, version: 1 });
    await confirmationSave.saving;
    assert.equal(f.operations.status('mysql', id).state, 'unknown_outcome');
    assert.deepEqual(f.operations.blockedSources(), ['mysql']);
    resume();
    const deadline = Date.now() + 1000;
    while (f.operations.status('mysql', id).state !== 'success' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.operations.status('mysql', id).state, 'success');
    assert.equal(f.operations.status('mysql', id).code, undefined);
    assert.deepEqual(f.operations.blockedSources(), []);
    assert.equal(JSON.parse((await f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id })).content[0].text).state, 'success');
    assert.equal(writes, 1);
    assert.ok(!(await readFile(path.join(f.dir, 'operations.json'), 'utf8')).includes('secret-test-value'));
  } finally { resume(); complete({ state: 'success' }); await f.cleanup(); }
});

test('cancelled application queue never submits a delayed write', async () => {
  let writes = 0, release: () => void = () => {};
  const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }), write: async () => { writes++; return { state: 'success' }; } }, 30);
  try {
    const id = await f.prepare();
    const blocked = f.registry.globalLimiter.run(() => new Promise<void>(resolve => { release = resolve; }));
    const result = JSON.parse((await f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id })).content[0].text);
    assert.equal(result.state, 'not_started');
    release(); await blocked; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(writes, 0);
  } finally { release(); await f.cleanup(); }
});

test('journal failure before submission prevents writes; after confirmed success reports degradation and closes new writes', async () => {
  for (const after of [false, true]) {
    let writes = 0;
    const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }), write: async (_p, _fp, _s, hooks) => {
      writes++; hooks.sent(); if (after) await rename(f.dir, f.dir + '-offline'); return { state: 'success', directAffected: 1 };
    } });
    let moved = false;
    try {
      const id = await f.prepare();
      if (!after) { await rename(f.dir, f.dir + '-offline'); moved = true; }
      const data = JSON.parse((await f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id })).content[0].text);
      if (after) { moved = true; assert.equal(data.state, 'success'); assert.equal(data.journalDegraded, true); }
      assert.equal(writes, after ? 1 : 0); assert.equal(f.operations.journal.healthy(), false);
      assert.equal((await f.dispatcher.call('mysql_prepare_write', { sourceId: 'mysql', table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 1, values: { name: 'next' } })).isError, true);
    } finally { if (moved) await rename(f.dir + '-offline', f.dir); await f.cleanup(); }
  }
});

for (const beforeSend of [false, true]) test('journal degradation prevents a pending source from sending a write ' +
  (beforeSend ? 'after driver setup' : 'after waiting in the queue'), { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-queued-journal-'));
  const input = configuration(dir);
  Object.assign(input.instance, { budgets: { maxConcurrent: 4 } });
  Object.assign(input.sources[0], { budgets: { queryTimeoutMs: 5000, queueTimeoutMs: 5000, maxConcurrent: 1 } });
  input.sources.push({ ...structuredClone(input.sources[0]), id: 'other' });
  const config = parseV2Config(input);
  const writes: string[] = [];
  let confirm: (outcome: WriteOutcome) => void = () => {}, entered: () => void = () => {};
  const sent = new Promise<void>(resolve => { entered = resolve; });
  let releaseBeforeSend: () => void = () => {}, enteredBeforeSend: () => void = () => {};
  const awaitingSend = new Promise<void>(resolve => { enteredBeforeSend = resolve; });
  const driverSetup = new Promise<void>(resolve => { releaseBeforeSend = resolve; });
  const registry = new SourceRegistry(config, async () => ({
    connect: async () => {}, close: async () => {}, read: async function* () {},
    writer: { preview: async () => ({ fingerprint: 'fixed', condition: 'match' }),
      write: async (plan, _fingerprint, _signal, hooks) => {
        if (beforeSend && plan.sourceId === 'other') { enteredBeforeSend(); await driverSetup; }
        hooks.sent(); writes.push(plan.sourceId);
        if (plan.sourceId === 'mysql') { entered(); return new Promise(resolve => { confirm = resolve; }); }
        return { state: 'success', directAffected: 1 };
      } },
  }));
  await registry.initialize();
  const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
  const operations = new Operations(registry, journal), dispatcher = new Dispatcher(registry, () => {}, operations);
  let unblock: () => void = () => {}, blocking: Promise<void> | undefined, moved = false;
  const commits: Array<Promise<unknown>> = [];
  try {
    const prepare = async (sourceId: string) => JSON.parse((await dispatcher.call('mysql_prepare_write', {
      sourceId, table: 'items', action: 'update', key: { tenant: 1, id: 2 }, expectedVersion: 0, values: { name: 'next' },
    })).content[0].text).operationId as string;
    const firstId = await prepare('mysql'), secondId = await prepare('other');
    if (!beforeSend) {
      let blocked: () => void = () => {};
      const occupied = new Promise<void>(resolve => { blocked = resolve; });
      blocking = registry.get('other').limiter.run(() => new Promise<void>(resolve => { unblock = resolve; blocked(); }));
      await occupied;
    }
    const first = dispatcher.call('commit_write', { sourceId: 'mysql', operationId: firstId }); commits.push(first);
    await sent;
    const second = dispatcher.call('commit_write', { sourceId: 'other', operationId: secondId }); commits.push(second);
    if (beforeSend) await awaitingSend;
    else {
      const deadline = Date.now() + 3000;
      while (!registry.get('other').limiter.snapshot().queued && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(registry.get('other').limiter.snapshot().queued, 1);
    }
    assert.equal(journal.get(secondId)?.state, 'pending');
    await rename(dir, dir + '-offline'); moved = true;
    confirm({ state: 'success', directAffected: 1 });
    const result = JSON.parse((await first).content[0].text);
    assert.equal(result.state, 'success'); assert.equal(result.journalDegraded, true); assert.equal(journal.healthy(), false);
    releaseBeforeSend(); unblock(); await blocking;
    const refused = JSON.parse((await second).content[0].text);
    assert.equal(refused.state, 'not_started'); assert.equal(refused.code, 'JOURNAL_UNAVAILABLE'); assert.equal(refused.journalDegraded, true);
    assert.deepEqual(writes, ['mysql']);
  } finally {
    confirm({ state: 'success', directAffected: 1 }); releaseBeforeSend(); unblock();
    await Promise.allSettled(commits); await blocking;
    if (moved) await rename(dir + '-offline', dir);
    await operations.stop(); await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt journal is never silently reset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-corrupt-'));
  try {
    await writeFile(path.join(dir, 'operations.json'), '{partial', { mode: 0o600 });
    await assert.rejects(OperationJournal.open({ directory: dir, maxOperations: 10, retentionDays: 7, previewTtlMs: 1000, maxPrepared: 2 }, 'writer'));
    assert.equal(await readFile(path.join(dir, 'operations.json'), 'utf8'), '{partial');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late confirmation after journal degradation remains truthful in status and duplicate commit', async () => {
  let complete: (result: WriteOutcome) => void = () => {}, entered: () => void = () => {};
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ preview: async () => ({ fingerprint: 'fixed', condition: 'match' }),
    write: async (_p, _fp, _s, hooks) => { hooks.sent(); entered(); return new Promise(resolve => { complete = resolve; }); } });
  let moved = false;
  try {
    const id = await f.prepare(), controller = new AbortController();
    const committed = f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id }, controller.signal);
    await sent; await rename(f.dir, f.dir + '-offline'); moved = true; controller.abort();
    const result = JSON.parse((await committed).content[0].text); assert.equal(result.state, 'unknown_outcome'); assert.equal(result.journalDegraded, true);
    complete({ state: 'success', directAffected: 1, version: 1 });
    const deadline = Date.now() + 1000;
    while (f.operations.status('mysql', id).state !== 'success' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const status = f.operations.status('mysql', id); assert.equal(status.state, 'success'); assert.equal(status.code, undefined); assert.equal(status.journalDegraded, true);
    assert.equal(JSON.parse((await f.dispatcher.call('commit_write', { sourceId: 'mysql', operationId: id })).content[0].text).state, 'success');
  } finally { complete({ state: 'success' }); if (moved) await rename(f.dir + '-offline', f.dir); await f.cleanup(); }
});

test('a killed writer leaves a lock; explicit stopped-instance recovery keeps durable pending unknown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-crash-'));
  const options = { directory: dir, maxOperations: 10, retentionDays: 7, previewTtlMs: 1000, maxPrepared: 2 };
  const script = `import {OperationJournal} from ${JSON.stringify(pathToFileURL(path.resolve('dist/runtime/journal.js')).href)};
    const journal = await OperationJournal.open(${JSON.stringify(options)}, 'crash');
    const record = await journal.prepare('mysql', 'mysql_prepare_write');
    await journal.pending(record.operationId); process.stdout.write(record.operationId + '\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    let output = '';
    const id = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.trim()); });
      child.once('error', reject); child.once('exit', () => reject(new Error('Crash fixture exited before durable pending')));
    });
    child.kill('SIGKILL'); await exited;
    await assert.rejects(OperationJournal.open(options, 'crash'));
    // Test-only administrator recovery, after the exact child process is confirmed exited.
    await unlink(path.join(dir, 'writer.lock'));
    const recovered = await OperationJournal.open(options, 'crash');
    assert.equal(recovered.get(id)?.state, 'unknown_outcome'); await recovered.close();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
