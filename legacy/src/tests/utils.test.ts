import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorResponse, buildSuccessResponse, configureResponseLimits } from '../utils/response.js';
import { buildInsert, buildWhereClause, escapeIdentifier } from '../utils/mysql.js';
import { ConfigLoader } from '../config/config-loader.js';
import { SecurityManager, SecurityMode } from '../security/security-manager.js';
import { isConnectorHealthy } from '../utils/connection-status.js';
import { RedisConnector } from '../connectors/redis.js';
import { RedisHandler } from '../handlers/redis.handler.js';
import { MySQLConnector } from '../connectors/mysql.js';
import { MySQLHandler } from '../handlers/mysql.handler.js';
import mysql from 'mysql2/promise';
import { ObjectId } from 'mongodb';
import { MongoDBConnector } from '../connectors/mongodb.js';
import { SecurityHandler } from '../handlers/security.handler.js';
import { MongoDBHandler } from '../handlers/mongodb.handler.js';

test('buildSuccessResponse serializes bigint and circular references', () => {
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
  const payload: { count: bigint; self?: unknown } = { count: 12n };
  payload.self = payload;

  const response = buildSuccessResponse(payload);
  const text = response.content[0]?.text ?? '';

  assert.match(text, /"count": "12"/);
  assert.match(text, /\[Circular\]/);
});

test('response serialization preserves MongoDB ObjectId and handles circular arrays', () => {
  const circular: unknown[] = [];
  circular.push(circular);
  const response = buildSuccessResponse({
    _id: new ObjectId('507f1f77bcf86cd799439011'),
    circular,
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data._id, '507f1f77bcf86cd799439011');
  assert.deepEqual(data.circular, ['[Circular]']);
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

  assert.equal(JSON.parse(text).__truncated, true);
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
});

test('response byte limit applies to strings and keeps structured truncation parseable', () => {
  configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 96 });
  try {
    const plain = buildSuccessResponse('x'.repeat(200)).content[0].text;
    const structured = buildSuccessResponse({ message: '中'.repeat(200) }).content[0].text;
    assert.ok(Buffer.byteLength(plain, 'utf8') <= 96);
    assert.ok(Buffer.byteLength(structured, 'utf8') <= 96);
    assert.equal(JSON.parse(structured).__truncated, true);
  } finally {
    configureResponseLimits({ maxResultItems: 200, maxResponseBytes: 65536 });
  }
});

test('response byte limit also applies to error messages', () => {
  configureResponseLimits({ maxResponseBytes: 80 });
  try {
    const text = buildErrorResponse(new Error('x'.repeat(200))).content[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 80);
  } finally {
    configureResponseLimits({ maxResponseBytes: 65536 });
  }
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

test('mysql WHERE builder matches null values', () => {
  assert.deepEqual(buildWhereClause({ deleted_at: null }, 'where'), {
    clause: '`deleted_at` IS NULL',
    values: [],
  });
});

test('MySQL pool applies the select limit before every query', async () => {
  const connector = new MySQLConnector({ host: 'unused', user: 'unused', password: '', pool: {} }, true, { selectLimit: 50 });
  const calls: string[] = [];
  (connector as unknown as { pool: unknown }).pool = {
    getConnection: async () => ({
      query: async (sql: string) => { calls.push(sql); },
      execute: async (sql: string) => { calls.push(sql); return [[{ id: 1 }]]; },
      release: () => { calls.push('release'); },
    }),
  };
  await connector.query('SELECT * FROM users');
  assert.deepEqual(calls, ['SET SESSION SQL_SELECT_LIMIT = ?', 'SELECT * FROM users', 'release']);
});

test('MySQL pool status uses underlying pool counters', async () => {
  const pool = mysql.createPool({ host: '127.0.0.1', user: 'unused', password: '', connectionLimit: 10 });
  const connector = new MySQLConnector({ host: 'unused', user: 'unused', password: '', pool: { max: 10 } }, true);
  (connector as unknown as { pool: unknown }).pool = pool;
  try {
    assert.equal(connector.getPoolStats()?.totalConnections, 0);
  } finally {
    await pool.end();
  }
});

test('mysql_connect enables default pool settings when usePool is true', async () => {
  const originalConnect = MySQLConnector.prototype.connect;
  MySQLConnector.prototype.connect = async () => undefined;
  try {
    const handler = new MySQLHandler(new SecurityManager());
    const result = await handler.handleConnect({ host: 'localhost', user: 'demo', password: '', usePool: true });
    assert.match(result.content[0].text, /使用连接池/);
    assert.equal((handler.getConnector() as unknown as { usePool: boolean }).usePool, true);
  } finally {
    MySQLConnector.prototype.connect = originalConnect;
  }
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
    process.env.REDIS_PORT = '6380garbage';
    assert.throws(() => ConfigLoader.loadFromEnv(), /REDIS_PORT/);
  } finally {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.DB_MCP_MYSQL_SELECT_LIMIT;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
  }
});

test('ConfigLoader merges individual runtime fields', () => {
  const loadFromFile = ConfigLoader.loadFromFile;
  const loadFromEnv = ConfigLoader.loadFromEnv;
  ConfigLoader.loadFromFile = () => ({ runtime: { maxResponseBytes: 1024, maxConcurrentMySql: 2 } });
  ConfigLoader.loadFromEnv = () => ({ runtime: { mysqlSelectLimit: 100 } });
  try {
    assert.deepEqual(ConfigLoader.load().runtime, {
      maxResponseBytes: 1024,
      maxConcurrentMySql: 2,
      mysqlSelectLimit: 100,
    });
  } finally {
    ConfigLoader.loadFromFile = loadFromFile;
    ConfigLoader.loadFromEnv = loadFromEnv;
  }
});

test('ConfigLoader overlays only database fields explicitly set in the environment', () => {
  const keys = ['MYSQL_HOST', 'MYSQL_POOL_MAX', 'REDIS_PORT', 'MONGODB_DATABASE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const loadFromFile = ConfigLoader.loadFromFile;
  ConfigLoader.loadFromFile = () => ({ databases: {
    mysql: { host: 'old-host', user: 'file-user', password: 'file-password', database: 'app', pool: { min: 2, max: 10 } },
    redis: { host: 'redis-host', password: 'redis-password', port: 6379 },
    mongodb: { url: 'mongodb://mongo-host:27017', database: 'old-db' },
  } });
  process.env.MYSQL_HOST = 'new-host';
  process.env.MYSQL_POOL_MAX = '20';
  process.env.REDIS_PORT = '6380';
  process.env.MONGODB_DATABASE = 'new-db';
  try {
    const config = ConfigLoader.load();
    assert.deepEqual(config.databases?.mysql, {
      host: 'new-host', user: 'file-user', password: 'file-password', database: 'app', pool: { min: 2, max: 20 },
    });
    assert.deepEqual(config.databases?.redis, { host: 'redis-host', password: 'redis-password', port: 6380 });
    assert.deepEqual(config.databases?.mongodb, { url: 'mongodb://mongo-host:27017', database: 'new-db' });
  } finally {
    ConfigLoader.loadFromFile = loadFromFile;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('ConfigLoader retains standalone environment defaults and reports an explicit missing file', () => {
  const loadFromFile = ConfigLoader.loadFromFile;
  const loadFromEnv = ConfigLoader.loadFromEnv;
  ConfigLoader.loadFromFile = () => ({});
  ConfigLoader.loadFromEnv = () => ({ databases: { mysql: { host: 'localhost' } } });
  try {
    assert.deepEqual(ConfigLoader.load().databases?.mysql, {
      host: 'localhost', user: 'root', password: '', pool: {},
    });
  } finally {
    ConfigLoader.loadFromFile = loadFromFile;
    ConfigLoader.loadFromEnv = loadFromEnv;
  }
  assert.throws(
    () => ConfigLoader.loadFromFile(`${process.cwd()}/db-mcp-missing-${process.pid}-${Date.now()}.json`),
    /加载配置文件失败/
  );
});

test('ConfigLoader rejects runtime limits that would disable safeguards', () => {
  const loadFromFile = ConfigLoader.loadFromFile;
  const loadFromEnv = ConfigLoader.loadFromEnv;
  ConfigLoader.loadFromFile = () => ({ runtime: { maxConcurrentMySql: 0 } });
  ConfigLoader.loadFromEnv = () => ({});
  try {
    assert.throws(() => ConfigLoader.load(), /maxConcurrentMySql/);
  } finally {
    ConfigLoader.loadFromFile = loadFromFile;
    ConfigLoader.loadFromEnv = loadFromEnv;
  }
});

test('SecurityManager blocks unsafe SQL in restricted mode', () => {
  const manager = new SecurityManager(SecurityMode.RESTRICTED);

  assert.equal(manager.isSQLAllowed('DELETE FROM users'), false);
  assert.equal(manager.isSQLAllowed('DELETE FROM users WHERE id = 1'), false);
  assert.equal(manager.isSQLAllowed('DELETE FROM users /* WHERE */'), false);
  assert.equal(manager.isSQLAllowed('UPDATE users SET active = 0'), false);
  assert.equal(manager.isSQLAllowed('INSERT INTO users (id) VALUES (1)'), true);
  assert.equal(manager.isSQLAllowed('ALTER TABLE users ADD COLUMN age INT'), false);
  assert.equal(manager.isSQLAllowed('CREATE TABLE audit (id INT)'), false);
  assert.equal(manager.isSQLAllowed('RENAME TABLE users TO old_users'), false);
});

test('restricted mode permits only structured MySQL deletes with a WHERE clause', async () => {
  const handler = new MySQLHandler(new SecurityManager(SecurityMode.RESTRICTED));
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  handler.setConnector({
    query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return { affectedRows: 1 }; },
  } as never);
  await handler.handleDelete({ table: 'users', where: { id: 7 } });
  assert.deepEqual(queries, [{ sql: 'DELETE FROM `users` WHERE `id` = ?', params: [7] }]);
  await assert.rejects(handler.handleDelete({ table: 'users', where: {} }), /where/);
});

test('tool calls cannot elevate security above the startup mode', () => {
  const manager = new SecurityManager(SecurityMode.READ_ONLY);
  const handler = new SecurityHandler(manager);
  assert.throws(() => handler.handleSetMode({ mode: 'full_access' }), /初始安全模式/);
  assert.equal(manager.getMode(), SecurityMode.READ_ONLY);
  const full = new SecurityManager(SecurityMode.FULL_ACCESS);
  const fullHandler = new SecurityHandler(full);
  fullHandler.handleSetMode({ mode: 'restricted' });
  fullHandler.handleSetMode({ mode: 'full_access' });
  assert.equal(full.getMode(), SecurityMode.FULL_ACCESS);
});

test('MongoDB find rejects limits that disable the configured cap', async () => {
  const handler = new MongoDBHandler(new SecurityManager(), { defaultLimit: 100, maxLimit: 500 });
  handler.setConnector({ find: async () => [] } as never);
  await assert.rejects(handler.handleFind({ collection: 'items', limit: 0 }), /limit/);
  await assert.rejects(handler.handleFind({ collection: 'items', limit: -1 }), /limit/);
});

test('MongoDB connect response does not repeat URL credentials', async () => {
  const originalConnect = MongoDBConnector.prototype.connect;
  MongoDBConnector.prototype.connect = async () => undefined;
  try {
    const handler = new MongoDBHandler(new SecurityManager());
    const result = await handler.handleConnect({ url: 'mongodb://alice:secret@localhost:27017/demo' });
    assert.match(result.content[0].text, /localhost:27017\/demo/);
    assert.doesNotMatch(result.content[0].text, /alice|secret/);
  } finally {
    MongoDBConnector.prototype.connect = originalConnect;
  }
});

test('Redis set accepts empty strings and rejects invalid TTL values', async () => {
  const handler = new RedisHandler(new SecurityManager(SecurityMode.RESTRICTED));
  const calls: Array<{ key: string; value: string; ttl?: number }> = [];
  handler.setConnector({
    set: async (key: string, value: string, ttl?: number) => { calls.push({ key, value, ttl }); },
  } as never);
  await handler.handleSet({ key: 'empty', value: '' });
  await assert.rejects(handler.handleSet({ key: 'empty', value: 'x', ttl: 0 }), /ttl/);
  assert.deepEqual(calls, [{ key: 'empty', value: '', ttl: undefined }]);
});

test('Redis scan tools reject unbounded workloads', async () => {
  const handler = new RedisHandler(new SecurityManager());
  handler.setConnector({} as never);
  await assert.rejects(handler.handleTopMemoryKeys({ maxKeys: 5001 }), /maxKeys/);
  await assert.rejects(handler.handleMemoryUsageByPrefixes({ prefixes: Array(11).fill('user:*') }), /prefixes/);
  await assert.rejects(handler.handleKeys({ pattern: '*', limit: 5001 }), /limit/);
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

test('RedisConnector exposes redis type and memory usage via sendCommand', async () => {
  const connector = new RedisConnector({});
  const calls: string[][] = [];

  (
    connector as unknown as {
      client: {
        sendCommand<T>(args: string[]): Promise<T>;
      };
    }
  ).client = {
    sendCommand: async <T>(args: string[]) => {
      calls.push(args);
      if (args[0] === 'TYPE') {
        return 'hash' as T;
      }
      return 128 as T;
    },
  };

  assert.equal(await connector.type('demo:key'), 'hash');
  assert.equal(await connector.memoryUsage('demo:key'), 128);
  assert.deepEqual(calls, [
    ['TYPE', 'demo:key'],
    ['MEMORY', 'USAGE', 'demo:key'],
  ]);
});

test('RedisConnector ranks top memory keys in current redis db', async () => {
  const connector = new RedisConnector({});
  const calls: string[][] = [];
  const memoryMap: Record<string, number | null> = {
    'k:1': 128,
    'k:2': 512,
    'k:3': 256,
  };
  const typeMap: Record<string, string> = {
    'k:2': 'hash',
    'k:3': 'string',
  };

  (
    connector as unknown as {
      client: {
        sendCommand<T>(args: string[]): Promise<T>;
        scanIterator(args: { MATCH: string; COUNT: number }): AsyncIterable<string>;
      };
    }
  ).client = {
    sendCommand: async <T>(args: string[]) => {
      calls.push(args);
      if (args[0] === 'MEMORY') {
        return memoryMap[args[2]] as T;
      }
      return typeMap[args[1]] as T;
    },
    async *scanIterator() {
      yield 'k:1';
      yield 'k:2';
      yield 'k:3';
    },
  };

  const result = await connector.topMemoryKeys({
    pattern: 'k:*',
    count: 2,
    maxKeys: 3,
    topN: 2,
  });

  assert.deepEqual(result, {
    pattern: 'k:*',
    scannedKeys: 3,
    scanCapped: true,
    topN: 2,
    items: [
      { key: 'k:2', bytes: 512, type: 'hash' },
      { key: 'k:3', bytes: 256, type: 'string' },
    ],
  });
  assert.deepEqual(calls, [
    ['MEMORY', 'USAGE', 'k:1'],
    ['MEMORY', 'USAGE', 'k:2'],
    ['MEMORY', 'USAGE', 'k:3'],
    ['TYPE', 'k:2'],
    ['TYPE', 'k:3'],
  ]);
});

test('Redis SCAN duplicates are returned and aggregated once', async () => {
  const connector = new RedisConnector({});
  (connector as unknown as { client: unknown }).client = {
    sendCommand: async (args: string[]) => args[0] === 'MEMORY' ? 100 : 'string',
    async *scanIterator() {
      yield 'user:1';
      yield 'user:1';
      yield 'user:2';
    },
  };
  assert.deepEqual(await connector.scanKeys('user:*', 100, 10), ['user:1', 'user:2']);
  const summary = await connector.autoPrefixMemoryUsage({ pattern: 'user:*', maxKeys: 10 });
  assert.equal(summary.scannedKeys, 3);
  assert.equal(summary.groups[0].matchedKeys, 2);
  assert.equal(summary.groups[0].totalBytes, 200);
});

test('RedisConnector aggregates memory usage by prefixes', async () => {
  const connector = new RedisConnector({});
  const calls: string[][] = [];
  const keysByPattern: Record<string, string[]> = {
    'user:*': ['user:1', 'user:2'],
    'session:*': ['session:1'],
    'cache:*': ['cache:1', 'cache:2'],
  };
  const memoryMap: Record<string, number | null> = {
    'user:1': 300,
    'user:2': 700,
    'session:1': 256,
    'cache:1': 100,
    'cache:2': 150,
  };

  (
    connector as unknown as {
      client: {
        sendCommand<T>(args: string[]): Promise<T>;
        scanIterator(args: { MATCH: string; COUNT: number }): AsyncIterable<string>;
      };
    }
  ).client = {
    sendCommand: async <T>(args: string[]) => {
      calls.push(args);
      return memoryMap[args[2]] as T;
    },
    async *scanIterator(args: { MATCH: string; COUNT: number }) {
      for (const key of keysByPattern[args.MATCH] ?? []) {
        yield key;
      }
    },
  };

  const result = await connector.memoryUsageByPrefixes({
    prefixes: ['user:*', 'session:*', 'cache:*'],
    count: 2,
    maxKeysPerPrefix: 10,
  });

  assert.deepEqual(result, {
    groups: [
      {
        pattern: 'user:*',
        scannedKeys: 2,
        scanCapped: false,
        matchedKeys: 2,
        totalBytes: 1000,
        largestKey: 'user:2',
        largestKeyBytes: 700,
      },
      {
        pattern: 'session:*',
        scannedKeys: 1,
        scanCapped: false,
        matchedKeys: 1,
        totalBytes: 256,
        largestKey: 'session:1',
        largestKeyBytes: 256,
      },
      {
        pattern: 'cache:*',
        scannedKeys: 2,
        scanCapped: false,
        matchedKeys: 2,
        totalBytes: 250,
        largestKey: 'cache:2',
        largestKeyBytes: 150,
      },
    ],
  });
  assert.deepEqual(
    calls.slice().sort((a, b) => a[2].localeCompare(b[2])),
    [
    ['MEMORY', 'USAGE', 'user:1'],
    ['MEMORY', 'USAGE', 'user:2'],
    ['MEMORY', 'USAGE', 'session:1'],
    ['MEMORY', 'USAGE', 'cache:1'],
    ['MEMORY', 'USAGE', 'cache:2'],
    ].sort((a, b) => a[2].localeCompare(b[2]))
  );
});

test('RedisConnector auto-discovers top memory prefixes', async () => {
  const connector = new RedisConnector({});
  const calls: string[][] = [];
  const memoryMap: Record<string, number | null> = {
    'user:1': 300,
    'user:2': 700,
    'session:1:data': 256,
    'session:2:data': 128,
    'cache:home': 900,
    plainkey: 64,
  };

  (
    connector as unknown as {
      client: {
        sendCommand<T>(args: string[]): Promise<T>;
        scanIterator(args: { MATCH: string; COUNT: number }): AsyncIterable<string>;
      };
    }
  ).client = {
    sendCommand: async <T>(args: string[]) => {
      calls.push(args);
      return memoryMap[args[2]] as T;
    },
    async *scanIterator() {
      yield 'user:1';
      yield 'user:2';
      yield 'session:1:data';
      yield 'session:2:data';
      yield 'cache:home';
      yield 'plainkey';
    },
  };

  const result = await connector.autoPrefixMemoryUsage({
    pattern: '*',
    separator: ':',
    depth: 1,
    count: 3,
    maxKeys: 10,
    topN: 3,
  });

  assert.deepEqual(result, {
    pattern: '*',
    separator: ':',
    depth: 1,
    scannedKeys: 6,
    scanCapped: false,
    topN: 3,
    groups: [
      {
        prefix: 'user:*',
        matchedKeys: 2,
        totalBytes: 1000,
        largestKey: 'user:2',
        largestKeyBytes: 700,
      },
      {
        prefix: 'cache:*',
        matchedKeys: 1,
        totalBytes: 900,
        largestKey: 'cache:home',
        largestKeyBytes: 900,
      },
      {
        prefix: 'session:*',
        matchedKeys: 2,
        totalBytes: 384,
        largestKey: 'session:1:data',
        largestKeyBytes: 256,
      },
    ],
  });
  assert.deepEqual(
    calls.slice().sort((a, b) => a[2].localeCompare(b[2])),
    [
      ['MEMORY', 'USAGE', 'user:1'],
      ['MEMORY', 'USAGE', 'user:2'],
      ['MEMORY', 'USAGE', 'session:1:data'],
      ['MEMORY', 'USAGE', 'session:2:data'],
      ['MEMORY', 'USAGE', 'cache:home'],
      ['MEMORY', 'USAGE', 'plainkey'],
    ].sort((a, b) => a[2].localeCompare(b[2]))
  );
});
