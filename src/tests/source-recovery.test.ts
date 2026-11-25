import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorReply } from 'redis';
import { parseV2Config } from '../config/v2.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { SafeError, type ErrorCode } from '../runtime/errors.js';
import { OperationJournal } from '../runtime/journal.js';
import { Operations } from '../runtime/operations.js';
import { SourceRegistry, type ReadAdapter } from '../runtime/sources.js';
import type { WriteOutcome } from '../runtime/write-policy.js';

const ssh = { host: '127.0.0.1', username: 'fixture', hostKeySha256: 'SHA256:' + 'A'.repeat(43),
  auth: { method: 'password', passwordRef: 'env:FIXTURE_SSH_PASSWORD' } };
const source = (id: string) => ({
  id, engine: 'redis', host: '127.0.0.1', username: 'fixture', passwordRef: 'env:FIXTURE_DB_PASSWORD',
  tls: { mode: 'disabled' }, access: {},
  budgets: { maxConcurrent: 1, maxConnections: 1, queryTimeoutMs: 5000, queueTimeoutMs: 2500 },
});
const instance = { name: 'recovery', environment: 'test', transport: 'stdio' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await wait(5);
  assert.ok(check(), 'timed out waiting for source recovery');
}

test('SSH source recovery isolates queued reads and leaves another source available', { timeout: 7000 }, async () => {
  const config = parseV2Config({ version: 2, instance, sources: [{ ...source('a'), ssh }, source('b')] });
  const reading = deferred<void>(), oldRead = deferred<void>(), closing = deferred<void>(), finishClose = deferred<void>();
  const opening = deferred<void>(), finishOpen = deferred<void>();
  let lost: (code: ErrorCode) => void = () => {};
  let attempts = 0, reopenedReads = 0;
  const adapter = (label: string): ReadAdapter => ({
    async connect() {}, async close() {}, async *read() { yield { label }; },
  });
  const registry = new SourceRegistry(config, async ({ id }) => {
    if (id === 'b') return adapter('unaffected');
    if (++attempts !== 1) return {
      ...adapter('new'),
      async connect() { opening.resolve(); await finishOpen.promise; },
      async *read() { reopenedReads++; yield { label: 'new' }; },
    };
    return {
      ...adapter('old'),
      onUnavailable(callback) { lost = callback; },
      async *read() { reading.resolve(); await oldRead.promise; yield { label: 'old' }; },
      async close() { closing.resolve(); oldRead.resolve(); await finishClose.promise; },
    };
  });
  const dispatcher = new Dispatcher(registry);
  const read = async (id: string) => JSON.parse((await dispatcher.call('redis_type', { sourceId: id, key: 'fixture' })).content[0].text);
  try {
    await registry.initialize();
    const inFlight = read('a');
    await reading.promise;
    const queued = read('a');
    await until(() => registry.get('a').limiter.snapshot().queued === 1);
    lost('SSH_UNAVAILABLE');
    assert.equal(registry.list()[0].status, 'reconnecting');
    await closing.promise;
    assert.equal((await read('b')).rows[0].label, 'unaffected');
    for (const result of await Promise.all([inFlight, queued])) assert.equal(result.error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(attempts, 1, 'unfinished teardown cannot overlap a new attempt');
    finishClose.resolve();
    await until(() => attempts === 2);
    await opening.promise;
    assert.equal((await read('a')).error.code, 'SOURCE_UNAVAILABLE', 'SSH alone is not readiness');
    finishOpen.resolve();
    await until(() => registry.list()[0].status === 'ready');
    lost('SSH_UNAVAILABLE'); // A stale callback from the retired connection.
    assert.equal((await read('a')).rows[0].label, 'new');
    assert.equal(reopenedReads, 1);
    assert.equal(attempts, 2);
    assert.equal(registry.list()[0].errorCode, undefined);
  } finally {
    oldRead.resolve(); finishClose.resolve(); finishOpen.resolve();
    await registry.close();
  }
});

test('optional SSH source retries transient startup failure but stops on an authentication rejection', { timeout: 7000 }, async () => {
  const config = parseV2Config({ version: 2, instance, sources: [
    { ...source('a'), ssh, required: false }, { ...source('b'), ssh, required: false },
  ] });
  const calls = { a: 0, b: 0 };
  const registry = new SourceRegistry(config, async ({ id }) => ({
    async connect() {
      if (id === 'a' && ++calls.a === 1) throw new SafeError('SSH_UNAVAILABLE');
      if (id === 'b') { calls.b++; throw new ErrorReply('WRONGPASS fixture text'); }
    },
    async close() {}, async *read() {},
  }));
  try {
    await registry.initialize();
    await until(() => registry.list()[0].status === 'ready');
    assert.equal(calls.a, 2);
    assert.equal(calls.b, 1);
    assert.deepEqual(registry.list()[1], { id: 'b', engine: 'redis', purpose: '', status: 'unavailable', errorCode: 'DATABASE_AUTH_FAILED' });
  } finally {
    await registry.close();
  }
});

test('optional SSH startup does not block foreground sources and shutdown closes a late adapter', { timeout: 7000 }, async () => {
  const config = parseV2Config({ version: 2, instance, sources: [
    { ...source('background'), ssh, required: false }, source('required'), { ...source('optionalDirect'), required: false },
  ] });
  const late = deferred<ReadAdapter>();
  const started: string[] = [];
  let connected = 0, closed = 0;
  const lateAdapter: ReadAdapter = {
    async connect() { connected++; }, async close() { closed++; }, async *read() {},
  };
  const registry = new SourceRegistry(config, async ({ id }) => {
    started.push(id);
    if (id === 'background') return late.promise;
    return { async connect() {}, async close() {}, async *read() {} };
  });
  let initialized = false;
  const starting = registry.initialize().then(() => { initialized = true; });
  try {
    await until(() => initialized);
    assert.deepEqual(started, ['required', 'optionalDirect', 'background']);
    assert.deepEqual(registry.list().map(entry => entry.status), ['reconnecting', 'ready', 'ready']);
    assert.equal(registry.list()[0].errorCode, undefined);
    let shutdownFinished = false;
    const shutdown = registry.close().then(() => { shutdownFinished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownFinished, false);
    late.resolve(lateAdapter);
    await shutdown;
    assert.equal(connected, 0); assert.equal(closed, 1);
  } finally { late.resolve(lateAdapter); await starting; await registry.close(); }
});

test('a required startup failure does not start optional SSH sources', async () => {
  const config = parseV2Config({ version: 2, instance, sources: [
    { ...source('background'), ssh, required: false }, source('required'),
  ] });
  const started: string[] = [];
  const registry = new SourceRegistry(config, async ({ id }) => {
    started.push(id);
    return {
      async connect() { if (id === 'required') throw new SafeError('SOURCE_UNAVAILABLE'); },
      async close() {}, async *read() {},
    };
  });
  try {
    await assert.rejects(registry.initialize(), { code: 'SOURCE_UNAVAILABLE' });
    assert.deepEqual(started, ['required']);
  } finally { await registry.close(); }
});

test('a write with a lost reply stays unknown after SSH recovery and is never sent again', { timeout: 7000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-ssh-recovery-journal-'));
  const config = parseV2Config({ version: 2, instance: { ...instance, tier: 'read_write', journal: { directory: dir } }, sources: [{
    ...source('a'), ssh, access: { tier: 'read_write', keyPrefixes: ['fixture:'], writes: { allowCreate: true } },
  }] });
  const sent = deferred<void>(), finished = deferred<WriteOutcome>();
  let lost: (code: ErrorCode) => void = () => {};
  let generations = 0, writes = 0;
  const registry = new SourceRegistry(config, async () => {
    const generation = ++generations;
    return {
      async connect() {}, async close() {}, async *read() { yield { generation }; },
      onUnavailable(callback) { if (generation === 1) lost = callback; },
      writer: {
        async preview() { return { condition: 'match', fingerprint: 'fixture' }; },
        async write(_plan, _fingerprint, _signal, hooks) { writes++; hooks.sent(); sent.resolve(); return finished.promise; },
      },
    };
  });
  let operations: Operations | undefined;
  try {
    await registry.initialize();
    const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
    operations = new Operations(registry, journal);
    const signal = new AbortController().signal;
    const prepare = () => operations!.prepare('redis_prepare_write', {
      sourceId: 'a', key: 'fixture:abc', action: 'create', value: 'next', ttl: { mode: 'clear' },
    }, signal) as Promise<{ operationId: string }>;
    const { operationId } = await prepare();
    const stale = await prepare();
    const committing = operations.commit('a', operationId, signal);
    await sent.promise;
    lost('SSH_UNAVAILABLE');
    assert.equal((await committing).state, 'unknown_outcome');
    await until(() => registry.list()[0].status === 'ready');
    assert.equal(generations, 2);
    assert.equal((await operations.commit('a', operationId, signal)).state, 'unknown_outcome');
    assert.equal(operations.status('a', operationId).state, 'unknown_outcome');
    await assert.rejects(prepare(), { code: 'WRITE_OUTCOME_UNKNOWN' });
    assert.equal((await operations.commit('a', stale.operationId, signal)).code, 'PREVIEW_EXPIRED');
    assert.equal(writes, 1);
    assert.equal(registry.globalLimiter.snapshot().active, 1, 'the interrupted driver still owns its real slot');
  } finally {
    finished.resolve({ state: 'unknown_outcome', code: 'WRITE_OUTCOME_UNKNOWN' });
    try { if (operations) await operations.stop(); else await registry.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('a queued commit from a closed SSH connection cannot cross over into the replacement', { timeout: 7000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-ssh-stale-queue-'));
  const config = parseV2Config({ version: 2, instance: { ...instance, tier: 'read_write', journal: { directory: dir } }, sources: [{
    ...source('a'), ssh, access: { tier: 'read_write', keyPrefixes: ['fixture:'], writes: { allowCreate: true } },
  }] });
  const release = deferred<void>();
  let lost: (code: ErrorCode) => void = () => {};
  let writes = 0, generations = 0;
  const registry = new SourceRegistry(config, async () => {
    const generation = ++generations;
    return {
      async connect() {}, async close() {}, async *read() {},
      onUnavailable(callback) { if (generation === 1) lost = callback; },
      writer: {
        async preview() { return { condition: 'match', fingerprint: 'fixture' }; },
        async write(_plan, _fingerprint, _signal, hooks) {
          hooks.sent(); writes++;
          return { state: 'success', directAffected: 1 };
        },
      },
    };
  });
  let operations: Operations | undefined;
  try {
    await registry.initialize();
    operations = new Operations(registry, await OperationJournal.open(config.instance.journal!, config.instance.name));
    const signal = new AbortController().signal;
    const prepare = () => operations!.prepare('redis_prepare_write', {
      sourceId: 'a', key: 'fixture:abc', action: 'create', value: 'next', ttl: { mode: 'clear' },
    }, signal) as Promise<{ operationId: string }>;
    const { operationId } = await prepare();
    const held = registry.get('a').limiter.run(() => release.promise);
    const queued = operations.commit('a', operationId, signal);
    await until(() => registry.get('a').limiter.snapshot().queued === 1);
    lost('SSH_UNAVAILABLE');
    const result = await queued;
    assert.equal(result.state, 'not_started');
    assert.equal(result.code, 'SOURCE_UNAVAILABLE');
    await until(() => registry.list()[0].status === 'ready');
    release.resolve(); await held;
    assert.equal(writes, 0);
    assert.equal((await operations.commit('a', operationId, signal)).state, 'not_started');
    const fresh = await prepare();
    assert.equal((await operations.commit('a', fresh.operationId, signal)).state, 'success');
    assert.equal(writes, 1);
  } finally {
    release.resolve();
    try { if (operations) await operations.stop(); else await registry.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('SSH disconnect releases only stale preview capacity and the expired state survives cleanup', { timeout: 7000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'db-mcp-recovery-preview-'));
  const access = { tier: 'read_write', keyPrefixes: ['fixture:'], writes: { allowCreate: true } };
  const config = parseV2Config({ version: 2, instance: { ...instance, tier: 'read_write',
    journal: { directory: dir, maxPrepared: 2 } }, sources: [
    { ...source('a'), ssh, access }, { ...source('b'), access },
  ] });
  let lost: (code: ErrorCode) => void = () => {};
  const registry = new SourceRegistry(config, async ({ id }) => ({
    async connect() {}, async close() {}, async *read() {},
    onUnavailable(callback) { if (id === 'a') lost = callback; },
    writer: {
      async preview() { return { condition: 'match', fingerprint: 'fixture' }; },
      async write() { return assert.fail('an expired preview must never send a write'); },
    },
  }));
  let operations: Operations | undefined;
  try {
    await registry.initialize();
    const journal = await OperationJournal.open(config.instance.journal!, config.instance.name);
    operations = new Operations(registry, journal);
    const signal = new AbortController().signal;
    const prepare = (sourceId: string) => operations!.prepare('redis_prepare_write', {
      sourceId, key: 'fixture:key', action: 'create', value: 'next', ttl: { mode: 'clear' },
    }, signal) as Promise<{ operationId: string; expiresAt: number }>;

    const stale = await prepare('a');
    const unaffected = await prepare('b');
    lost('SSH_UNAVAILABLE');
    assert.equal(operations.status('a', stale.operationId).code, 'PREVIEW_EXPIRED');
    await until(() => registry.list()[0].status === 'ready');
    const fresh = await prepare('a');

    assert.equal(journal.get(stale.operationId)?.state, 'not_started');
    assert.equal(operations.status('b', unaffected.operationId).state, 'prepared');
    await assert.rejects(prepare('b'), { code: 'BUDGET_EXCEEDED' });

    t.mock.method(Date, 'now', () => fresh.expiresAt + 1);
    assert.equal(operations.status('a', fresh.operationId).code, 'PREVIEW_EXPIRED');
    await prepare('a');
    assert.equal(operations.status('a', stale.operationId).state, 'not_started');
    assert.equal((await operations.commit('a', stale.operationId, signal)).code, 'PREVIEW_EXPIRED');
  } finally {
    try { if (operations) await operations.stop(); else await registry.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
