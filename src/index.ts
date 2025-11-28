#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { MySQLConnector, MySQLConfig } from './connectors/mysql.js';
import { RedisConnector, RedisConfig } from './connectors/redis.js';
import { MongoDBConnector, MongoDBConfig } from './connectors/mongodb.js';
import { SecurityManager, SecurityMode, OperationType } from './security/security-manager.js';
import { ConfigLoader } from './config/config-loader.js';

// 加载配置
const appConfig = ConfigLoader.load();

// 全局连接器实例
let mysqlConnector: MySQLConnector | null = null;
let redisConnector: RedisConnector | null = null;
let mongodbConnector: MongoDBConnector | null = null;

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

// 初始化预配置的连接
async function initializePreconfiguredConnections() {
  // 初始化 MySQL 连接（如果配置了）
  if (appConfig.databases?.mysql) {
    try {
      const mysqlConfig = appConfig.databases.mysql;
      const usePool = mysqlConfig.pool !== undefined;
      mysqlConnector = new MySQLConnector(mysqlConfig, usePool);
      await mysqlConnector.connect();
      process.stderr.write(`✓ MySQL 连接已初始化${usePool ? '（使用连接池）' : ''}\n`);
    } catch (error) {
      process.stderr.write(`✗ MySQL 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // 初始化 Redis 连接（如果配置了）
  if (appConfig.databases?.redis) {
    try {
      redisConnector = new RedisConnector(appConfig.databases.redis);
      await redisConnector.connect();
      process.stderr.write('✓ Redis 连接已初始化\n');
    } catch (error) {
      process.stderr.write(`✗ Redis 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // 初始化 MongoDB 连接（如果配置了）
  if (appConfig.databases?.mongodb) {
    try {
      mongodbConnector = new MongoDBConnector(appConfig.databases.mongodb);
      await mongodbConnector.connect();
      process.stderr.write('✓ MongoDB 连接已初始化\n');
    } catch (error) {
      process.stderr.write(`✗ MongoDB 连接初始化失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
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
    description: '执行 MySQL SQL 查询',
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
    description: '查找匹配模式的 Redis 键',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '键的模式，例如 "user:*"' },
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
];

// 处理工具列表请求
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

// 处理工具调用请求
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // MySQL 操作
      case 'mysql_connect': {
        const mysqlConfig = args as unknown as MySQLConfig & { usePool?: boolean };
        const usePool = mysqlConfig.usePool === true && mysqlConfig.pool !== undefined;
        
        // 如果已有连接，先断开
        if (mysqlConnector) {
          await mysqlConnector.disconnect();
        }
        
        mysqlConnector = new MySQLConnector(mysqlConfig, usePool);
        await mysqlConnector.connect();
        return {
          content: [
            {
              type: 'text',
              text: `成功连接到 MySQL 数据库: ${mysqlConfig.host}:${mysqlConfig.port || 3306}${usePool ? '（使用连接池）' : ''}`,
            },
          ],
        };
      }

      case 'mysql_query': {
        if (!mysqlConnector) {
          throw new Error('MySQL 未连接，请先使用 mysql_connect 连接数据库');
        }
        const { sql, params } = args as { sql: string; params?: any[] };
        
        // 安全检查
        if (!securityManager.isSQLAllowed(sql)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行此 SQL 语句。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        
        const result = await mysqlConnector.query(sql, params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mysql_disconnect': {
        if (mysqlConnector) {
          await mysqlConnector.disconnect();
          mysqlConnector = null;
          return {
            content: [
              {
                type: 'text',
                text: '已断开 MySQL 数据库连接',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'MySQL 数据库未连接',
            },
          ],
        };
      }

      case 'mysql_pool_status': {
        if (!mysqlConnector) {
          throw new Error('MySQL 未连接，请先使用 mysql_connect 连接数据库');
        }
        const poolStats = mysqlConnector.getPoolStats();
        if (!poolStats) {
          return {
            content: [
              {
                type: 'text',
                text: '当前未使用连接池',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(poolStats, null, 2),
            },
          ],
        };
      }

      // Redis 操作
      case 'redis_connect': {
        const redisConfig = args as unknown as RedisConfig;
        // 如果已有连接，先断开
        if (redisConnector) {
          await redisConnector.disconnect();
        }
        redisConnector = new RedisConnector(redisConfig);
        await redisConnector.connect();
        const host = redisConfig.url ? new URL(redisConfig.url).hostname : redisConfig.host;
        const port = redisConfig.url ? new URL(redisConfig.url).port || 6379 : (redisConfig.port || 6379);
        return {
          content: [
            {
              type: 'text',
              text: `成功连接到 Redis 数据库: ${host}:${port}`,
            },
          ],
        };
      }

      case 'redis_get': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        const { key } = args as { key: string };
        const value = await redisConnector.get(key);
        return {
          content: [
            {
              type: 'text',
              text: value === null ? `键 "${key}" 不存在` : JSON.stringify(value),
            },
          ],
        };
      }

      case 'redis_set': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.SET)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 SET 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { key, value, ttl } = args as { key: string; value: string; ttl?: number };
        await redisConnector.set(key, value, ttl);
        return {
          content: [
            {
              type: 'text',
              text: `成功设置键 "${key}"${ttl ? `，过期时间: ${ttl}秒` : ''}`,
            },
          ],
        };
      }

      case 'redis_keys': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        const { pattern } = args as { pattern: string };
        const keys = await redisConnector.keys(pattern);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(keys, null, 2),
            },
          ],
        };
      }

      case 'redis_del': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.DELETE)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 DELETE 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { key } = args as { key: string };
        const deleted = await redisConnector.del(key);
        return {
          content: [
            {
              type: 'text',
              text: deleted > 0 ? `成功删除键 "${key}"` : `键 "${key}" 不存在`,
            },
          ],
        };
      }

      case 'redis_hget': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        const { key, field } = args as { key: string; field: string };
        const value = await redisConnector.hget(key, field);
        return {
          content: [
            {
              type: 'text',
              text: value === undefined ? `字段 "${field}" 不存在` : JSON.stringify(value),
            },
          ],
        };
      }

      case 'redis_hgetall': {
        if (!redisConnector) {
          throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
        }
        const { key } = args as { key: string };
        const result = await redisConnector.hgetall(key);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'redis_disconnect': {
        if (redisConnector) {
          await redisConnector.disconnect();
          redisConnector = null;
          return {
            content: [
              {
                type: 'text',
                text: '已断开 Redis 数据库连接',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Redis 数据库未连接',
            },
          ],
        };
      }

      // MongoDB 操作
      case 'mongodb_connect': {
        const mongodbConfig = args as unknown as MongoDBConfig;
        mongodbConnector = new MongoDBConnector(mongodbConfig);
        await mongodbConnector.connect();
        return {
          content: [
            {
              type: 'text',
              text: `成功连接到 MongoDB 数据库: ${mongodbConfig.url}`,
            },
          ],
        };
      }

      case 'mongodb_find': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        const { collection, filter = {}, limit, skip, sort } = args as {
          collection: string;
          filter?: any;
          limit?: number;
          skip?: number;
          sort?: any;
        };
        const options: any = {};
        if (limit) options.limit = limit;
        if (skip) options.skip = skip;
        if (sort) options.sort = sort;
        const result = await mongodbConnector.find(collection, filter, options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_find_one': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        const { collection, filter = {} } = args as { collection: string; filter?: any };
        const result = await mongodbConnector.findOne(collection, filter);
        return {
          content: [
            {
              type: 'text',
              text: result === null ? '未找到匹配的文档' : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_insert_one': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.INSERT)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 INSERT 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { collection, document } = args as { collection: string; document: any };
        const result = await mongodbConnector.insertOne(collection, document);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_insert_many': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.INSERT)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 INSERT 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { collection, documents } = args as { collection: string; documents: any[] };
        const result = await mongodbConnector.insertMany(collection, documents);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_update_one': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.UPDATE)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 UPDATE 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { collection, filter, update } = args as {
          collection: string;
          filter: any;
          update: any;
        };
        const result = await mongodbConnector.updateOne(collection, filter, update);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_delete_one': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        if (!securityManager.isOperationAllowed(OperationType.DELETE)) {
          throw new Error(
            `当前安全模式（${securityManager.getMode()}）不允许执行 DELETE 操作。` +
            `允许的操作：${securityManager.getModeDescription()}`
          );
        }
        const { collection, filter } = args as { collection: string; filter: any };
        const result = await mongodbConnector.deleteOne(collection, filter);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'mongodb_count': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        const { collection, filter = {} } = args as { collection: string; filter?: any };
        const count = await mongodbConnector.countDocuments(collection, filter);
        return {
          content: [
            {
              type: 'text',
              text: `匹配的文档数量: ${count}`,
            },
          ],
        };
      }

      case 'mongodb_list_collections': {
        if (!mongodbConnector) {
          throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
        }
        const collections = await mongodbConnector.listCollections();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(collections, null, 2),
            },
          ],
        };
      }

      case 'mongodb_disconnect': {
        if (mongodbConnector) {
          await mongodbConnector.disconnect();
          mongodbConnector = null;
          return {
            content: [
              {
                type: 'text',
                text: '已断开 MongoDB 数据库连接',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'MongoDB 数据库未连接',
            },
          ],
        };
      }

      // 安全配置操作
      case 'set_security_mode': {
        const { mode } = args as { mode: string };
        const securityMode = mode as SecurityMode;
        if (!Object.values(SecurityMode).includes(securityMode)) {
          throw new Error(`无效的安全模式: ${mode}。有效值: read_only, restricted, full_access`);
        }
        securityManager.setMode(securityMode);
        return {
          content: [
            {
              type: 'text',
              text: `安全模式已设置为: ${securityMode}\n${securityManager.getModeDescription()}`,
            },
          ],
        };
      }

      case 'get_security_mode': {
        return {
          content: [
            {
              type: 'text',
              text: `当前安全模式: ${securityManager.getMode()}\n${securityManager.getModeDescription()}`,
            },
          ],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `错误: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
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

