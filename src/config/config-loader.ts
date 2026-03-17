import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { MySQLConfig } from '../connectors/mysql.js';
import { RedisConfig } from '../connectors/redis.js';
import { MongoDBConfig } from '../connectors/mongodb.js';

export interface DatabaseConfig {
  mysql?: MySQLConfig & {
    pool?: {
      min?: number;
      max?: number;
      idleTimeout?: number;
    };
  };
  redis?: RedisConfig;
  mongodb?: MongoDBConfig;
}

export interface AppConfig {
  databases?: DatabaseConfig;
  security?: {
    mode?: 'read_only' | 'restricted' | 'full_access';
  };
  runtime?: {
    operationTimeoutMs?: number;
    maxResultItems?: number;
    maxResponseBytes?: number;
    defaultMongoLimit?: number;
    maxMongoLimit?: number;
    mysqlSelectLimit?: number;
    maxConcurrentMySql?: number;
    maxConcurrentRedis?: number;
    maxConcurrentMongo?: number;
  };
}

function parseInteger(value: string | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`环境变量 ${fieldName} 必须是整数`);
  }

  return parsed;
}

/**
 * 配置加载器
 */
export class ConfigLoader {
  /**
   * 从文件加载配置
   */
  static loadFromFile(filePath?: string): AppConfig {
    const configPath = filePath ||
      process.env.DB_MCP_CONFIG_PATH ||
      join(process.cwd(), 'config.json');
    
    try {
      const configContent = readFileSync(configPath, 'utf-8');
      return JSON.parse(configContent) as AppConfig;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // 配置文件不存在，返回空配置
        return {};
      }
      throw new Error(`加载配置文件失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 从环境变量加载配置
   */
  static loadFromEnv(): AppConfig {
    const config: AppConfig = {};

    // MySQL 配置
    if (process.env.MYSQL_HOST) {
      config.databases = config.databases || {};
      config.databases.mysql = {
        host: process.env.MYSQL_HOST,
        port: parseInteger(process.env.MYSQL_PORT, 3306, 'MYSQL_PORT'),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE,
        pool: {
          min: parseInteger(process.env.MYSQL_POOL_MIN, 2, 'MYSQL_POOL_MIN'),
          max: parseInteger(process.env.MYSQL_POOL_MAX, 10, 'MYSQL_POOL_MAX'),
          idleTimeout: parseInteger(process.env.MYSQL_POOL_IDLE_TIMEOUT, 60000, 'MYSQL_POOL_IDLE_TIMEOUT'),
        },
      };
    }

    // Redis 配置
    if (process.env.REDIS_HOST || process.env.REDIS_URL) {
      config.databases = config.databases || {};
      config.databases.redis = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInteger(process.env.REDIS_PORT, 6379, 'REDIS_PORT'),
        password: process.env.REDIS_PASSWORD,
        db: parseInteger(process.env.REDIS_DB, 0, 'REDIS_DB'),
        url: process.env.REDIS_URL,
      };
    }

    // MongoDB 配置
    if (process.env.MONGODB_URL) {
      config.databases = config.databases || {};
      config.databases.mongodb = {
        url: process.env.MONGODB_URL,
        database: process.env.MONGODB_DATABASE,
      };
    }

    // 安全模式配置
    if (process.env.DB_MCP_SECURITY_MODE) {
      config.security = {
        mode: process.env.DB_MCP_SECURITY_MODE as 'read_only' | 'restricted' | 'full_access',
      };
    }

    if (process.env.DB_MCP_OPERATION_TIMEOUT_MS) {
      config.runtime = config.runtime || {};
      config.runtime.operationTimeoutMs = parseInteger(
        process.env.DB_MCP_OPERATION_TIMEOUT_MS,
        30000,
        'DB_MCP_OPERATION_TIMEOUT_MS'
      );
    }

    if (process.env.DB_MCP_MAX_RESULT_ITEMS) {
      config.runtime = config.runtime || {};
      config.runtime.maxResultItems = parseInteger(
        process.env.DB_MCP_MAX_RESULT_ITEMS,
        200,
        'DB_MCP_MAX_RESULT_ITEMS'
      );
    }

    if (process.env.DB_MCP_MAX_RESPONSE_BYTES) {
      config.runtime = config.runtime || {};
      config.runtime.maxResponseBytes = parseInteger(
        process.env.DB_MCP_MAX_RESPONSE_BYTES,
        65536,
        'DB_MCP_MAX_RESPONSE_BYTES'
      );
    }

    if (process.env.DB_MCP_DEFAULT_MONGO_LIMIT) {
      config.runtime = config.runtime || {};
      config.runtime.defaultMongoLimit = parseInteger(
        process.env.DB_MCP_DEFAULT_MONGO_LIMIT,
        100,
        'DB_MCP_DEFAULT_MONGO_LIMIT'
      );
    }

    if (process.env.DB_MCP_MAX_MONGO_LIMIT) {
      config.runtime = config.runtime || {};
      config.runtime.maxMongoLimit = parseInteger(
        process.env.DB_MCP_MAX_MONGO_LIMIT,
        500,
        'DB_MCP_MAX_MONGO_LIMIT'
      );
    }

    if (process.env.DB_MCP_MYSQL_SELECT_LIMIT) {
      config.runtime = config.runtime || {};
      config.runtime.mysqlSelectLimit = parseInteger(
        process.env.DB_MCP_MYSQL_SELECT_LIMIT,
        500,
        'DB_MCP_MYSQL_SELECT_LIMIT'
      );
    }

    if (process.env.DB_MCP_MAX_CONCURRENT_MYSQL) {
      config.runtime = config.runtime || {};
      config.runtime.maxConcurrentMySql = parseInteger(
        process.env.DB_MCP_MAX_CONCURRENT_MYSQL,
        4,
        'DB_MCP_MAX_CONCURRENT_MYSQL'
      );
    }

    if (process.env.DB_MCP_MAX_CONCURRENT_REDIS) {
      config.runtime = config.runtime || {};
      config.runtime.maxConcurrentRedis = parseInteger(
        process.env.DB_MCP_MAX_CONCURRENT_REDIS,
        16,
        'DB_MCP_MAX_CONCURRENT_REDIS'
      );
    }

    if (process.env.DB_MCP_MAX_CONCURRENT_MONGO) {
      config.runtime = config.runtime || {};
      config.runtime.maxConcurrentMongo = parseInteger(
        process.env.DB_MCP_MAX_CONCURRENT_MONGO,
        6,
        'DB_MCP_MAX_CONCURRENT_MONGO'
      );
    }

    return config;
  }

  /**
   * 加载配置（优先从文件，然后从环境变量）
   */
  static load(): AppConfig {
    const fileConfig = this.loadFromFile();
    const envConfig = this.loadFromEnv();
    const databases = {
      ...fileConfig.databases,
      ...envConfig.databases,
      mysql: envConfig.databases?.mysql || fileConfig.databases?.mysql,
      redis: envConfig.databases?.redis || fileConfig.databases?.redis,
      mongodb: envConfig.databases?.mongodb || fileConfig.databases?.mongodb,
    };

    // 合并配置，环境变量优先级更高
    return {
      databases: Object.values(databases).some((value) => value !== undefined) ? databases : undefined,
      security: envConfig.security || fileConfig.security,
      runtime: envConfig.runtime || fileConfig.runtime,
    };
  }
}
