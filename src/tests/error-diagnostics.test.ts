import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { parseV2Config } from '../config/v2.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { clientErrorDetails, SafeError } from '../runtime/errors.js';
import { SourceRegistry, type ReadAdapter } from '../runtime/sources.js';

async function fixture(read: ReadAdapter['read'], budgets: Record<string, number> = {}) {
  const config = parseV2Config({ version: 2, instance: { name: 'diagnostics', transport: 'stdio', environment: 'test' }, sources: [{
    id: 'mysql', engine: 'mysql', host: 'localhost', database: 'reports', username: 'reader', passwordRef: 'env:FIXTURE_PASSWORD',
    tls: { mode: 'disabled' }, access: {}, budgets,
  }] });
  const registry = new SourceRegistry(config, async () => ({ async connect() {}, async close() {}, read }));
  const dispatcher = new Dispatcher(registry);
  await registry.initialize();
  const call = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await dispatcher.call(tool, { sourceId: 'mysql', ...args }, signal);
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.doesNotMatch(text, /PRIVATE_/);
    const { error } = JSON.parse(text);
    assert.match(error.requestId, /^[0-9a-f-]{36}$/);
    return error;
  };
  return { registry, call };
}

test('schema and cursor errors include a safe path without exposing caller keys and values', async () => {
  const f = await fixture(async function* () { assert.fail('invalid requests must stop before reading'); });
  try {
    const filter = await f.call('mysql_select', { table: 'reports', where: { PRIVATE_KEY: { value: 'PRIVATE_VALUE' } } });
    assert.equal(filter.code, 'INVALID_ARGUMENT');
    assert.deepEqual(filter.details, { path: '$.where', reason: 'invalid_value', nextAction: 'check_arguments' });
    const field = await f.call('mysql_select', { table: 'reports', PRIVATE_KEY: 'PRIVATE_VALUE' });
    assert.deepEqual(field.details, { path: '$', reason: 'unknown_field', nextAction: 'check_arguments' });
    const sort = await f.call('mysql_select', { table: 'reports', orderBy: [{ field: 'id', direction: 'PRIVATE_VALUE' }] });
    assert.deepEqual(sort.details, { path: '$.orderBy[0].direction', reason: 'invalid_sort_direction', nextAction: 'check_arguments' });
    assert.match(sort.message, /asc.*desc/);
    const cursor = await f.call('mysql_list_tables', { cursor: 'PRIVATE_VALUE' });
    assert.equal(cursor.code, 'INVALID_ARGUMENT');
    assert.deepEqual(cursor.details, { path: '$.cursor', reason: 'invalid_cursor', nextAction: 'restart_pagination' });
    const unauthorized = await f.call('mysql_select', { sourceId: 'PRIVATE_SOURCE', table: 'reports' });
    assert.equal(unauthorized.code, 'SCOPE_DENIED');
    assert.equal(unauthorized.details, undefined);
  } finally { await f.registry.close(); }
});

test('native query rejections are indistinguishable from each other and distinct from transport failures', async () => {
  const byTable = new Map([['missing', 'ER_NO_SUCH_TABLE'], ['denied', 'ER_TABLEACCESS_DENIED_ERROR'], ['offline', 'PROTOCOL_CONNECTION_LOST']]);
  const f = await fixture(async function* (plan) {
    throw Object.assign(new Error('PRIVATE_CONNECTION PRIVATE_SQL'), { code: byTable.get(plan.target!) });
  });
  try {
    for (const table of ['missing', 'denied']) {
      const error = await f.call('mysql_select', { table });
      assert.equal(error.code, 'SOURCE_UNAVAILABLE');
      assert.deepEqual(error.details, { reason: 'query_rejected', nextAction: 'check_query' });
    }
    const lost = await f.call('mysql_select', { table: 'offline' });
    assert.equal(lost.code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(lost.details, { reason: 'source_connection_lost', nextAction: 'check_source_status' });
  } finally { await f.registry.close(); }
});

test('read callers can distinguish a full queue, wait timeout, query timeout and cancellation', async () => {
  const f = await fixture(async function* (_plan, signal) {
    await wait(1000, undefined, { signal });
  }, { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 30, queryTimeoutMs: 150, maxRequestBytes: 1024 });
  const args = { table: 'reports' };
  const limiter = f.registry.get('mysql').limiter;
  let release = () => {};
  const held = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    const pending = f.call('mysql_select', args);
    assert.equal(limiter.snapshot().queued, 1);
    const full = await f.call('mysql_select', args);
    assert.equal(full.code, 'BUDGET_EXCEEDED');
    assert.deepEqual(full.details, { reason: 'queue_full', nextAction: 'retry_read_later' });
    const oversized = await f.call('mysql_select', { ...args, where: { name: 'x'.repeat(1100) } });
    assert.deepEqual(oversized.details, { reason: 'request_too_large', nextAction: 'reduce_request' });
    const queued = await pending;
    assert.equal(queued.code, 'REQUEST_CANCELLED');
    assert.deepEqual(queued.details, { reason: 'queue_timeout', nextAction: 'retry_read_later' });
    release(); await held;
    const query = await f.call('mysql_select', args);
    assert.equal(query.code, 'REQUEST_CANCELLED');
    assert.deepEqual(query.details, { reason: 'query_timeout', nextAction: 'narrow_query' });
    const cancelled = await f.call('mysql_select', args, AbortSignal.abort());
    assert.equal(cancelled.code, 'REQUEST_CANCELLED');
    assert.deepEqual(cancelled.details, { reason: 'caller_cancelled' });
    assert.deepEqual(clientErrorDetails(new SafeError('BUDGET_EXCEEDED', { reason: 'queue_full' }), false), { reason: 'queue_full' });
  } finally { release(); await held; await f.registry.close(); }
});
