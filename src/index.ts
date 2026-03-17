#!/usr/bin/env node

import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { MySQLConnector } from './connectors/mysql.js';
import { RedisConnector } from './connectors/redis.js';
import { MongoDBConnector } from './connectors/mongodb.js';
import { SecurityManager, SecurityMode } from './security/security-manager.js';
import { ConfigLoader } from './config/config-loader.js';
import { MySQLHandler } from './handlers/mysql.handler.js';
import { RedisHandler } from './handlers/redis.handler.js';
import { MongoDBHandler } from './handlers/mongodb.handler.js';
import { SecurityHandler } from './handlers/security.handler.js';
import { buildErrorResponse, configureResponseLimits } from './utils/response.js';
import { withTimeout } from './utils/async.js';
import { ConcurrencyLimiter } from './utils/concurrency.js';

// 加载配置
const appConfig = ConfigLoader.load();
const operationTimeoutMs = appConfig.runtime?.operationTimeoutMs ?? 30000;
const maxResultItems = appConfig.runtime?.maxResultItems ?? 200;
const maxResponseBytes = appConfig.runtime?.maxResponseBytes ?? 65536;
const defaultMongoLimit = appConfig.runtime?.defaultMongoLimit ?? 100;
const maxMongoLimit = appConfig.runtime?.maxMongoLimit ?? 500;
const mysqlSelectLimit = appConfig.runtime?.mysqlSelectLimit ?? 500;
const maxConcurrentMySql = appConfig.runtime?.maxConcurrentMySql ?? 4;
const maxConcurrentRedis = appConfig.runtime?.maxConcurrentRedis ?? 16;
const maxConcurrentMongo = appConfig.runtime?.maxConcurrentMongo ?? 6;

configureResponseLimits({
  maxResultItems,
  maxResponseBytes,
});

// 全局安全管理器
function getSecurityMode(): SecurityMode {
  // 优先使用配置文件中的模式
  if (appConfig.security?.mode) {
    const mode = appConfig.security.mode as SecurityMode;
    if (Object.values(SecurityMode).includes(mode)) {
      return mode;
    }
  }
  
  // 其次使用环境变量
  if (process.env.DB_MCP_SECURITY_MODE) {
    const mode = process.env.DB_MCP_SECURITY_MODE as SecurityMode;
    if (Object.values(SecurityMode).includes(mode)) {
      return mode;
    }
  }
  
  // 默认只读模式
  return SecurityMode.READ_ONLY;
}

const securityManager = new SecurityManager(getSecurityMode());

// 初始化各个处理器
const mysqlHandler = new MySQLHandler(securityManager, {
  selectLimit: mysqlSelectLimit,
});
const redisHandler = new RedisHandler(securityManager);
const mongodbHandler = new MongoDBHandler(securityManager, {
  defaultLimit: defaultMongoLimit,
  maxLimit: maxMongoLimit,
});
const securityHandler = new SecurityHandler(securityManager);
const mysqlLimiter = new ConcurrencyLimiter(maxConcurrentMySql);
const redisLimiter = new ConcurrencyLimiter(maxConcurrentRedis);
const mongoLimiter = new ConcurrencyLimiter(maxConcurrentMongo);

async function closeAllConnections() {
  await mysqlHandler.handleDisconnect().catch(() => undefined);
  await redisHandler.handleDisconnect().catch(() => undefined);
  await mongodbHandler.handleDisconnect().catch(() => undefined);
}

// 初始化预配置的连接
async function initializePreconfiguredConnections() {
  // 初始化 MySQL 连接（如果配置了）
  if (appConfig.databases?.mysql) {
    try {
      const mysqlConfig = appConfig.databases.mysql;
      const usePool = mysqlConfig.pool !== undefined;
      const connector = new MySQLConnector(mysqlConfig, usePool, {
        selectLimit: mysqlSelectLimit,
      });
      await connector.connect();
      mysqlHandler.setConnector(connector);
      process.stderr.write(
        `✓ MySQL 连接已初始化${usePool ? '（使用连接池）' : ''}，SQL_SELECT_LIMIT=${mysqlSelectLimit}\n`
      );
    } catch (error) {
      process.stderr.write(`✗ MySQL 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // 初始化 Redis 连接（如果配置了）
  if (appConfig.databases?.redis) {
    try {
      const connector = new RedisConnector(appConfig.databases.redis);
      await connector.connect();
      redisHandler.setConnector(connector);
      process.stderr.write('✓ Redis 连接已初始化\n');
    } catch (error) {
      process.stderr.write(`✗ Redis 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // 初始化 MongoDB 连接（如果配置了）
  if (appConfig.databases?.mongodb) {
    try {
      const connector = new MongoDBConnector(appConfig.databases.mongodb);
      await connector.connect();
      mongodbHandler.setConnector(connector);
      process.stderr.write('✓ MongoDB 连接已初始化\n');
    } catch (error) {
      process.stderr.write(`✗ MongoDB 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function getRuntimeStatus() {
  return {
    security: {
      mode: securityManager.getMode(),
      description: securityManager.getModeDescription(),
    },
    runtime: {
      operationTimeoutMs,
      maxResultItems,
      maxResponseBytes,
      mysqlSelectLimit,
      defaultMongoLimit,
      maxMongoLimit,
      concurrency: {
        mysql: mysqlLimiter.snapshot(),
        redis: redisLimiter.snapshot(),
        mongodb: mongoLimiter.snapshot(),
      },
    },
    connections: {
      mysql: {
        configured: appConfig.databases?.mysql !== undefined,
        connected: mysqlHandler.getConnector() !== null,
        pool: mysqlHandler.getConnector()?.getPoolStats() ?? null,
      },
      redis: {
        configured: appConfig.databases?.redis !== undefined,
        connected: redisHandler.getConnector() !== null,
      },
      mongodb: {
        configured: appConfig.databases?.mongodb !== undefined,
        connected: mongodbHandler.getConnector() !== null,
      },
    },
  };
}

const server = new Server(
  {
    name: 'db-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

type ToolResponse = {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
};

// 定义工具列表
const tools: Tool[] = [
  // MySQL 工具
  {
    name: 'mysql_connect',
    description: '连接到 MySQL 数据库（支持连接池）',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'MySQL 主机地址' },
        port: { type: 'number', description: 'MySQL 端口，默认 3306' },
        user: { type: 'string', description: 'MySQL 用户名' },
        password: { type: 'string', description: 'MySQL 密码' },
        database: { type: 'string', description: '数据库名称（可选）' },
        usePool: { type: 'boolean', description: '是否使用连接池（可选）' },
        pool: {
          type: 'object',
          description: '连接池配置（可选）',
          properties: {
            min: { type: 'number', description: '最小连接数，默认 2' },
            max: { type: 'number', description: '最大连接数，默认 10' },
            idleTimeout: { type: 'number', description: '空闲超时时间（毫秒），默认 60000' },
          },
        },
      },
      required: ['host', 'user', 'password'],
    },
  },
  {
    name: 'mysql_query',
    description: '执行 MySQL SQL 语句（支持 SELECT、INSERT、UPDATE、DELETE 等所有 SQL 操作）',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '要执行的 SQL 语句' },
        params: {
          type: 'array',
          description: 'SQL 参数（可选）',
          items: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'mysql_insert',
    description: '执行 MySQL INSERT 插入操作',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: '表名' },
        data: {
          type: 'object',
          description: '要插入的数据（键值对）',
        },
      },
      required: ['table', 'data'],
    },
  },
  {
    name: 'mysql_update',
    description: '执行 MySQL UPDATE 更新操作',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: '表名' },
        data: {
          type: 'object',
          description: '要更新的数据（键值对）',
        },
        where: {
          type: 'object',
          description: 'WHERE 条件（键值对，支持多个条件）',
        },
      },
      required: ['table', 'data', 'where'],
    },
  },
  {
    name: 'mysql_delete',
    description: '执行 MySQL DELETE 删除操作',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: '表名' },
        where: {
          type: 'object',
          description: 'WHERE 条件（键值对，支持多个条件）',
        },
      },
      required: ['table', 'where'],
    },
  },
  {
    name: 'mysql_disconnect',
    description: '断开 MySQL 数据库连接',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mysql_pool_status',
    description: '获取 MySQL 连接池状态（如果使用连接池）',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // Redis 工具
  {
    name: 'redis_connect',
    description: '连接到 Redis 数据库',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Redis 主机地址' },
        port: { type: 'number', description: 'Redis 端口，默认 6379' },
        password: { type: 'string', description: 'Redis 密码（可选）' },
        db: { type: 'number', description: 'Redis 数据库编号，默认 0' },
        url: { type: 'string', description: 'Redis 连接 URL（可选，如果提供则忽略其他参数）' },
      },
      required: ['host'],
    },
  },
  {
    name: 'redis_get',
    description: '从 Redis 获取键的值',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis 键名' },
      },
      required: ['key'],
    },
  },
  {
    name: 'redis_set',
    description: '设置 Redis 键的值',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Redis 键名' },
        value: { type: 'string', description: '要设置的值' },
        ttl: { type: 'number', description: '过期时间（秒，可选）' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'redis_keys',
    description: '使用 SCAN 查找匹配模式的 Redis 键，避免 KEYS 阻塞实例',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '键的模式，例如 "user:*"' },
        count: { type: 'number', description: '每次 SCAN 批量大小，默认 100' },
        limit: { type: 'number', description: '最多返回多少个键，默认 500' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'redis_del',
    description: '删除 Redis 键',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '要删除的键名' },
      },
      required: ['key'],
    },
  },
  {
    name: 'redis_hget',
    description: '获取 Redis 哈希字段的值',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '哈希键名' },
        field: { type: 'string', description: '字段名' },
      },
      required: ['key', 'field'],
    },
  },
  {
    name: 'redis_hgetall',
    description: '获取 Redis 哈希的所有字段和值',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '哈希键名' },
      },
      required: ['key'],
    },
  },
  {
    name: 'redis_disconnect',
    description: '断开 Redis 数据库连接',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // MongoDB 工具
  {
    name: 'mongodb_connect',
    description: '连接到 MongoDB 数据库',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'MongoDB 连接 URL，例如 mongodb://localhost:27017' },
        database: { type: 'string', description: '数据库名称（可选，可从 URL 中提取）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mongodb_find',
    description: '在 MongoDB 集合中查找文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        filter: { type: 'object', description: '查询过滤器（JSON 对象）' },
        limit: { type: 'number', description: '返回文档数量限制（可选）' },
        skip: { type: 'number', description: '跳过的文档数量（可选）' },
        sort: { type: 'object', description: '排序规则（可选）' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'mongodb_find_one',
    description: '在 MongoDB 集合中查找单个文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        filter: { type: 'object', description: '查询过滤器（JSON 对象）' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'mongodb_insert_one',
    description: '向 MongoDB 集合插入单个文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        document: { type: 'object', description: '要插入的文档（JSON 对象）' },
      },
      required: ['collection', 'document'],
    },
  },
  {
    name: 'mongodb_insert_many',
    description: '向 MongoDB 集合插入多个文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        documents: {
          type: 'array',
          description: '要插入的文档数组',
          items: { type: 'object' },
        },
      },
      required: ['collection', 'documents'],
    },
  },
  {
    name: 'mongodb_update_one',
    description: '更新 MongoDB 集合中的单个文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        filter: { type: 'object', description: '查询过滤器（JSON 对象）' },
        update: { type: 'object', description: '更新操作（JSON 对象，使用 $set 等操作符）' },
      },
      required: ['collection', 'filter', 'update'],
    },
  },
  {
    name: 'mongodb_delete_one',
    description: '删除 MongoDB 集合中的单个文档',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        filter: { type: 'object', description: '查询过滤器（JSON 对象）' },
      },
      required: ['collection', 'filter'],
    },
  },
  {
    name: 'mongodb_count',
    description: '统计 MongoDB 集合中匹配的文档数量',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: '集合名称' },
        filter: { type: 'object', description: '查询过滤器（JSON 对象，可选）' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'mongodb_list_collections',
    description: '列出 MongoDB 数据库中的所有集合',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mongodb_disconnect',
    description: '断开 MongoDB 数据库连接',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // 安全配置工具
  {
    name: 'set_security_mode',
    description: '设置安全模式：read_only（只读模式）、restricted（限制模式）、full_access（完全开发模式）',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['read_only', 'restricted', 'full_access'],
          description: '安全模式：read_only（只读）、restricted（限制）、full_access（完全访问）',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'get_security_mode',
    description: '获取当前安全模式',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'server_runtime_status',
    description: '获取服务运行时状态，包括并发限制、队列、响应限制、超时和连接状态',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResponse> | ToolResponse> = {
  mysql_connect: (args) => mysqlHandler.handleConnect(args),
  mysql_query: (args) => mysqlHandler.handleQuery(args),
  mysql_disconnect: () => mysqlHandler.handleDisconnect(),
  mysql_pool_status: () => mysqlHandler.handlePoolStatus(),
  mysql_insert: (args) => mysqlHandler.handleInsert(args),
  mysql_update: (args) => mysqlHandler.handleUpdate(args),
  mysql_delete: (args) => mysqlHandler.handleDelete(args),
  redis_connect: (args) => redisHandler.handleConnect(args),
  redis_get: (args) => redisHandler.handleGet(args),
  redis_set: (args) => redisHandler.handleSet(args),
  redis_keys: (args) => redisHandler.handleKeys(args),
  redis_del: (args) => redisHandler.handleDelete(args),
  redis_hget: (args) => redisHandler.handleHGet(args),
  redis_hgetall: (args) => redisHandler.handleHGetAll(args),
  redis_disconnect: () => redisHandler.handleDisconnect(),
  mongodb_connect: (args) => mongodbHandler.handleConnect(args),
  mongodb_find: (args) => mongodbHandler.handleFind(args),
  mongodb_find_one: (args) => mongodbHandler.handleFindOne(args),
  mongodb_insert_one: (args) => mongodbHandler.handleInsertOne(args),
  mongodb_insert_many: (args) => mongodbHandler.handleInsertMany(args),
  mongodb_update_one: (args) => mongodbHandler.handleUpdateOne(args),
  mongodb_delete_one: (args) => mongodbHandler.handleDeleteOne(args),
  mongodb_count: (args) => mongodbHandler.handleCount(args),
  mongodb_list_collections: () => mongodbHandler.handleListCollections(),
  mongodb_disconnect: () => mongodbHandler.handleDisconnect(),
  set_security_mode: (args) => securityHandler.handleSetMode(args),
  get_security_mode: () => securityHandler.handleGetMode(),
  server_runtime_status: () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(getRuntimeStatus(), null, 2),
      },
    ],
  }),
};

function getLimiter(name: string): ConcurrencyLimiter | null {
  if (name.startsWith('mysql_')) {
    return mysqlLimiter;
  }
  if (name.startsWith('redis_')) {
    return redisLimiter;
  }
  if (name.startsWith('mongodb_')) {
    return mongoLimiter;
  }
  return null;
}

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const handler = toolHandlers[name];
    if (!handler) {
      throw new Error(`未知的工具: ${name}`);
    }

    const limiter = getLimiter(name);
    const task = () =>
      withTimeout(
        Promise.resolve(handler(args)),
        operationTimeoutMs,
        `工具 ${name} 执行超时（>${operationTimeoutMs}ms）`
      );

    return limiter ? await limiter.run(task) : await task();
  } catch (error) {
    return buildErrorResponse(error);
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 服务器已启动（MCP 使用 stdio，错误输出到 stderr）
  process.stderr.write('db-mcp 服务器已启动\n');
  
  // 初始化预配置的连接
  await initializePreconfiguredConnections();
}

main().catch((error) => {
  process.stderr.write(`服务器启动失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`未处理的 Promise 异常: ${String(reason)}\n`);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`未捕获异常: ${error.message}\n`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  process.stderr.write(`收到 ${signal}，正在关闭数据库连接...\n`);
  await closeAllConnections();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
