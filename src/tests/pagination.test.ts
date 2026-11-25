import assert from 'node:assert/strict';
import test from 'node:test';
import { parseV2Config } from '../config/v2.js';
import { Dispatcher } from '../runtime/dispatcher.js';
import { ListRow } from '../runtime/pagination.js';
import { SourceRegistry } from '../runtime/sources.js';

const tables = ['first', 'second'];
const config = parseV2Config({
  version: 2, instance: { name: 'pagination', transport: 'stdio', environment: 'test' },
  sources: ['a', 'b'].map(id => ({
    id, engine: 'mysql', host: '127.0.0.1', database: 'test', username: 'reader', passwordRef: 'env:UNUSED_FIXTURE',
    tls: { mode: 'disabled' }, access: { tables },
    budgets: { maxRows: 10, maxItemBytes: 800, maxResponseBytes: 1024 },
  })),
});

function fixture(values: string[]) {
  return new SourceRegistry(config, async () => ({
    async connect() {}, async close() {},
    async *read(plan) {
      const offset = Number(plan.position ?? 0);
      for (let i = offset; i < Math.min(values.length, offset + plan.limit + 1); i++) {
        yield new ListRow({ name: values[i] }, i + 1);
      }
    },
  }));
}

test('list cursor is scoped to the server, source, tool and target, and can be replayed', async () => {
  const registry = fixture(['one', 'two', 'three']);
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const args = { sourceId: 'a', table: 'first', limit: 1 };
    const first = await dispatcher.call('mysql_describe_table', args);
    assert.equal(first.isError, undefined);
    const result = JSON.parse(first.content[0].text);
    assert.deepEqual(result.rows, [{ name: 'one' }]);
    assert.equal(result.reason, 'row_limit');
    const cursor = result.nextCursor;
    assert.equal(typeof cursor, 'string');
    const continuation = { ...args, limit: 2, cursor };
    for (const invalid of [
      await dispatcher.call('mysql_describe_table', { ...continuation, sourceId: 'b' }),
      await dispatcher.call('mysql_describe_table', { ...continuation, table: 'second' }),
      await dispatcher.call('mysql_list_tables', { sourceId: 'a', cursor }),
      await dispatcher.call('mysql_describe_table', { ...continuation, cursor: (cursor[0] === 'a' ? 'b' : 'a') + cursor.slice(1) }),
      await new Dispatcher(registry).call('mysql_describe_table', continuation),
    ]) {
      assert.equal(invalid.isError, true);
      assert.equal(JSON.parse(invalid.content[0].text).error.code, 'INVALID_ARGUMENT');
    }
    const second = await dispatcher.call('mysql_describe_table', continuation);
    assert.deepEqual(JSON.parse(second.content[0].text), { rows: [{ name: 'two' }, { name: 'three' }], truncated: false });
    assert.deepEqual(await dispatcher.call('mysql_describe_table', continuation), second);
  } finally { await registry.close(); }
});

test('response byte truncation resumes at the next unsent list row', async () => {
  const values = ['a', 'b', 'c'].map(value => value.repeat(455));
  const registry = fixture(values);
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const args = { sourceId: 'a', limit: 3 };
    const first = await dispatcher.call('mysql_list_tables', args);
    assert.equal(first.isError, undefined);
    const page = JSON.parse(first.content[0].text);
    assert.equal(page.reason, 'response_bytes');
    assert.deepEqual(page.rows, [{ name: values[0] }]);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024);
    const second = await dispatcher.call('mysql_list_tables', { ...args, cursor: page.nextCursor });
    assert.deepEqual(JSON.parse(second.content[0].text), {
      rows: values.slice(1).map(name => ({ name })), truncated: false,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 1024);
  } finally { await registry.close(); }
});

test('single-result tools only mark actual response truncation', async () => {
  const scoped = parseV2Config({
    version: 2, instance: { name: 'read-completion', transport: 'stdio', environment: 'test' },
    sources: [
      { id: 'docs', engine: 'mongodb', database: 'test', connectionStringRef: 'env:UNUSED_FIXTURE',
        tls: { mode: 'disabled' }, access: {}, budgets: { maxRows: 1, maxItemBytes: 256 } },
      { id: 'cache', engine: 'redis', host: '127.0.0.1', passwordRef: 'env:UNUSED_FIXTURE',
        tls: { mode: 'disabled' }, access: {}, budgets: { maxRows: 1 } },
    ],
  });
  const registry = new SourceRegistry(scoped, async () => ({
    async connect() {}, async close() {},
    async *read(plan) {
      if (plan.target === 'missing') return;
      yield plan.target === 'large' ? { value: 'x'.repeat(300) } : { id: 'one' };
    },
  }));
  await registry.initialize();
  try {
    const dispatcher = new Dispatcher(registry);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await dispatcher.call(name, args);
      assert.equal(result.isError, undefined);
      return JSON.parse(result.content[0].text);
    };
    const mongo = { sourceId: 'docs', collection: 'items' };
    assert.deepEqual(await call('mongodb_find_one', mongo), { rows: [{ id: 'one' }], truncated: false });
    assert.deepEqual(await call('mongodb_find_one', { ...mongo, collection: 'missing' }), { rows: [], truncated: false });
    assert.deepEqual(await call('mongodb_find_one', { ...mongo, collection: 'large' }), { rows: [], truncated: true, reason: 'item_bytes' });
    assert.deepEqual(await call('mongodb_find', mongo), { rows: [{ id: 'one' }], truncated: true, reason: 'row_limit' });
    assert.deepEqual(await call('redis_type', { sourceId: 'cache', key: 'one' }), { rows: [{ id: 'one' }], truncated: false });
  } finally { await registry.close(); }
});
