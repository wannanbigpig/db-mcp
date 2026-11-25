import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseV2Config } from '../config/v2.js';
import { SourceRegistry } from '../runtime/sources.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { Operations } from '../runtime/operations.js';
import { OperationJournal } from '../runtime/journal.js';

for (const phase of ['read', 'preview', 'commit'] as const) test('a source waiting for its own capacity does not block another source: ' + phase,
  { timeout: 10000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-admission-'));
    let operations: Operations | undefined, registry: SourceRegistry | undefined;
    let release = () => {}, entered = () => {}, hold = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending: Array<Promise<unknown>> = [];
    try {
      const source = { engine: 'mysql', host: 'localhost', database: 'test', username: 'writer',
        passwordRef: 'env:UNUSED_ADMISSION_FIXTURE', tls: { mode: 'disabled' },
        budgets: { maxConcurrent: 1, maxConnections: 1, maxQueued: 2, queueTimeoutMs: 1000 },
        access: { tier: 'read_write', tables: ['items'], columns: { items: ['id', 'version', 'name'] },
          writes: { metadataGuard: 'guard', tables: { items: { keyColumns: ['id'], versionColumn: 'version',
            writableColumns: ['name'], allowUpdate: true } } } } };
      const config = parseV2Config({ version: 2, instance: { name: 'admission', transport: 'stdio', environment: 'test',
        tier: 'read_write', journal: { directory: dir }, budgets: { maxConcurrent: 2, maxQueued: 2 } }, sources: [
        { ...source, id: 'a' }, { ...source, id: 'b', budgets: { ...source.budgets, queueTimeoutMs: 50 } },
      ] });
      const wait = async (id: string) => { if (hold && id === 'a') { entered(); await blocked; } };
      registry = new SourceRegistry(config, async configured => ({
        connect: async () => {}, close: async () => {},
        read: async function* () { await wait(configured.id); yield { name: 'visible' }; },
        writer: { preview: async () => { await wait(configured.id); return { fingerprint: 'fixed', condition: 'match' }; },
          write: async (_plan, _fingerprint, _signal, hooks) => {
            hooks.sent(); await wait(configured.id); return { state: 'success', directAffected: 1 };
          } },
      }));
      await registry.initialize();
      operations = new Operations(registry, await OperationJournal.open(config.instance.journal!, config.instance.name));
      const dispatcher = new Dispatcher(registry, () => {}, operations);
      const input = (sourceId: string) => ({ sourceId, table: 'items', action: 'update', key: { id: 1 }, expectedVersion: 0, values: { name: 'next' } });
      const ids: string[] = [];
      if (phase === 'commit') for (const id of ['a', 'a', 'b']) {
        const preview = await dispatcher.call('mysql_prepare_write', input(id));
        assert.equal(preview.isError, undefined); ids.push(JSON.parse(preview.content[0].text).operationId);
      }
      const call = (id: string, index: number) => phase === 'read' ? dispatcher.call('mysql_select', { sourceId: id, table: 'items' }) :
        phase === 'preview' ? dispatcher.call('mysql_prepare_write', input(id)) :
          dispatcher.call('commit_write', { sourceId: id, operationId: ids[index] });
      hold = true;
      pending.push(call('a', 0)); await started;
      pending.push(call('a', 1));
      const deadline = Date.now() + 2000;
      while (!registry.get('a').limiter.snapshot().queued && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(registry.get('a').limiter.snapshot().queued, 1);
      assert.equal(registry.globalLimiter.snapshot().active, 1, 'a queued request must not reserve global execution capacity');
      assert.equal(registry.globalLimiter.snapshot().queued, 1);
      const other = await call('b', 2);
      assert.equal(other.isError, undefined, other.content[0].text);
      if (phase === 'commit') assert.equal(JSON.parse(other.content[0].text).state, 'success');
      assert.equal(registry.get('a').limiter.snapshot().active, 1);
    } finally {
      release(); await Promise.allSettled(pending);
      if (operations) await operations.stop(); else await registry?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test('write commits preserve queue timeout and overflow codes without sending a write', { timeout: 7000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-commit-admission-'));
  const config = parseV2Config({ version: 2, instance: { name: 'admission', transport: 'stdio',
    environment: 'test', tier: 'read_write', journal: { directory: dir } }, sources: [{
    id: 'cache', engine: 'redis', host: 'localhost', username: 'writer', passwordRef: 'env:UNUSED_ADMISSION_FIXTURE',
    tls: { mode: 'disabled' }, budgets: { maxConcurrent: 1, maxConnections: 1, maxQueued: 1, queueTimeoutMs: 1000 },
    access: { tier: 'read_write', keyPrefixes: ['fixture:'], writes: { allowCreate: true } },
  }] });
  let writes = 0;
  const registry = new SourceRegistry(config, async () => ({
    async connect() {}, async close() {}, async *read() {},
    writer: {
      async preview() { return { fingerprint: 'fixed', condition: 'match' }; },
      async write() { writes++; return { state: 'success' }; },
    },
  }));
  let operations: Operations | undefined;
  let release = () => {};
  let held: Promise<void> | undefined;
  try {
    await registry.initialize();
    operations = new Operations(registry, await OperationJournal.open(config.instance.journal!, config.instance.name));
    const dispatcher = new Dispatcher(registry, () => {}, operations);
    const sourceId = 'cache';
    const call = async (tool: string, args: Record<string, unknown>) =>
      JSON.parse((await dispatcher.call(tool, { sourceId, ...args })).content[0].text);
    const prepare = (key: string) => call('redis_prepare_write', { key, action: 'create', value: 'next', ttl: { mode: 'clear' } });
    const first = await prepare('fixture:first');
    const second = await prepare('fixture:second');
    const limiter = registry.get(sourceId).limiter;
    held = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
    const queued = call('commit_write', { operationId: first.operationId });
    const deadline = Date.now() + 2000;
    while (limiter.snapshot().queued === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(limiter.snapshot().queued, 1);

    const overflow = await call('commit_write', { operationId: second.operationId });
    const expired = await queued;
    assert.equal(overflow.state, 'not_started');
    assert.equal(overflow.code, 'BUDGET_EXCEEDED');
    assert.equal(expired.state, 'not_started');
    assert.equal(expired.code, 'REQUEST_CANCELLED');
    assert.equal(operations.status(sourceId, second.operationId).code, overflow.code);
    assert.equal(operations.status(sourceId, first.operationId).code, expired.code);
    assert.equal(registry.get(sourceId).status, 'ready');
    assert.equal(writes, 0);
  } finally {
    release(); await held;
    try { if (operations) await operations.stop(); else await registry.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
