import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuccessResponse, configureResponseLimits } from '../utils/response.js';
import { buildInsert, buildWhereClause, escapeIdentifier } from '../utils/mysql.js';
import { ConfigLoader } from '../config/config-loader.js';
import { SecurityManager, SecurityMode } from '../security/security-manager.js';
import { withTimeout } from '../utils/async.js';
import { ConcurrencyLimiter } from '../utils/concurrency.js';
import { isConnectorHealthy } from '../utils/connection-status.js';

test('buildSuccessResponse serializes bigint and circular references', () => {
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
  const payload: { count: bigint; self?: unknown } = { count: 12n };
  payload.self = payload;

  const response = buildSuccessResponse(payload);
  const text = response.content[0]?.text ?? '';

  assert.match(text, /"count": "12"/);
  assert.match(text, /\[Circular\]/);
});

test('buildSuccessResponse truncates oversized arrays', () => {
  configureResponseLimits({ maxResultItems: 2, maxResponseBytes: 65536 });
  const response = buildSuccessResponse({
    rows: [
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' },
    ],
  });
  const text = response.content[0]?.text ?? '';

  assert.match(text, /__truncated/);
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
});

test('buildSuccessResponse truncates oversized payload text', () => {
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 80 });
  const response = buildSuccessResponse({
    message: 'x'.repeat(200),
  });
  const text = response.content[0]?.text ?? '';

  assert.match(text, /响应已截断/);
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
});

test('escapeIdentifier rejects unsafe mysql identifiers', () => {
  assert.equal(escapeIdentifier('users', 'table'), '`users`');
  assert.throws(() => escapeIdentifier('users;DROP TABLE users', 'table'));
});

test('mysql builders keep values parameterized', () => {
  const insert = buildInsert({ id: 1, name: 'alice' }, 'data');
  const where = buildWhereClause({ id: 1 }, 'where');

  assert.equal(insert.columns, '`id`, `name`');
  assert.equal(insert.placeholders, '?, ?');
  assert.deepEqual(insert.values, [1, 'alice']);
  assert.equal(where.clause, '`id` = ?');
  assert.deepEqual(where.values, [1]);
});

test('ConfigLoader prefers env config and validates numeric env vars', () => {
  process.env.MYSQL_HOST = '127.0.0.1';
  process.env.MYSQL_PORT = '3307';
  process.env.DB_MCP_MYSQL_SELECT_LIMIT = '321';
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = '6380';

  try {
    const config = ConfigLoader.loadFromEnv();

    assert.equal(config.databases?.mysql?.port, 3307);
    assert.equal(config.databases?.redis?.port, 6380);
    assert.equal(config.runtime?.mysqlSelectLimit, 321);

    process.env.REDIS_PORT = 'bad';
    assert.throws(() => ConfigLoader.loadFromEnv(), /REDIS_PORT/);
  } finally {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.DB_MCP_MYSQL_SELECT_LIMIT;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
  }
});

test('SecurityManager blocks unsafe SQL in restricted mode', () => {
  const manager = new SecurityManager(SecurityMode.RESTRICTED);

  assert.equal(manager.isSQLAllowed('DELETE FROM users'), false);
  assert.equal(manager.isSQLAllowed('DELETE FROM users WHERE id = 1'), true);
  assert.equal(manager.isSQLAllowed('ALTER TABLE users ADD COLUMN age INT'), false);
});

test('withTimeout rejects slow operations', async () => {
  await assert.rejects(
    withTimeout(
      new Promise((resolve) => setTimeout(resolve, 30)),
      5,
      'timeout'
    ),
    /timeout/
  );
});

test('ConcurrencyLimiter queues tasks beyond configured concurrency', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const order: string[] = [];

  await Promise.all([
    limiter.run(async () => {
      order.push('start-1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('end-1');
    }),
    limiter.run(async () => {
      order.push('start-2');
      order.push('end-2');
    }),
  ]);

  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, maxConcurrent: 1 });
});

test('isConnectorHealthy reflects connector health and guards failures', async () => {
  assert.equal(await isConnectorHealthy(null), false);
  assert.equal(await isConnectorHealthy({ testConnection: async () => true }), true);
  assert.equal(await isConnectorHealthy({ testConnection: async () => false }), false);
  assert.equal(
    await isConnectorHealthy({
      testConnection: async () => {
        throw new Error('boom');
      },
    }),
    false
  );
});
