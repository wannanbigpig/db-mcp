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

interface EnvConfig extends Omit<AppConfig, 'databases'> {
  databases?: {
    mysql?: Partial<DatabaseConfig['mysql']>;
    redis?: Partial<RedisConfig>;
    mongodb?: Partial<MongoDBConfig>;
  };
}

function parseInteger(value: string | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
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
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT' &&
          !filePath && !process.env.DB_MCP_CONFIG_PATH) {
        // 仅默认配置文件缺失时允许使用纯环境变量启动。
        return {};
      }
      throw new Error(`加载配置文件失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 从环境变量加载配置
   */
  static loadFromEnv(): EnvConfig {
    const config: EnvConfig = {};

    // MySQL 配置
    if (['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
      'MYSQL_POOL_MIN', 'MYSQL_POOL_MAX', 'MYSQL_POOL_IDLE_TIMEOUT'].some((key) => process.env[key] !== undefined)) {
      config.databases = config.databases || {};
      const mysql: NonNullable<EnvConfig['databases']>['mysql'] = {};
      if (process.env.MYSQL_HOST !== undefined) mysql.host = process.env.MYSQL_HOST;
      if (process.env.MYSQL_PORT !== undefined) mysql.port = parseInteger(process.env.MYSQL_PORT, 3306, 'MYSQL_PORT');
      if (process.env.MYSQL_USER !== undefined) mysql.user = process.env.MYSQL_USER;
      if (process.env.MYSQL_PASSWORD !== undefined) mysql.password = process.env.MYSQL_PASSWORD;
      if (process.env.MYSQL_DATABASE !== undefined) mysql.database = process.env.MYSQL_DATABASE;
      if (['MYSQL_POOL_MIN', 'MYSQL_POOL_MAX', 'MYSQL_POOL_IDLE_TIMEOUT'].some((key) => process.env[key] !== undefined)) {
        mysql.pool = {};
        if (process.env.MYSQL_POOL_MIN !== undefined) mysql.pool.min = parseInteger(process.env.MYSQL_POOL_MIN, 2, 'MYSQL_POOL_MIN');
        if (process.env.MYSQL_POOL_MAX !== undefined) mysql.pool.max = parseInteger(process.env.MYSQL_POOL_MAX, 10, 'MYSQL_POOL_MAX');
        if (process.env.MYSQL_POOL_IDLE_TIMEOUT !== undefined) mysql.pool.idleTimeout = parseInteger(process.env.MYSQL_POOL_IDLE_TIMEOUT, 60000, 'MYSQL_POOL_IDLE_TIMEOUT');
      }
      config.databases.mysql = mysql;
    }

    // Redis 配置
    if (['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_DB', 'REDIS_URL']
      .some((key) => process.env[key] !== undefined)) {
      config.databases = config.databases || {};
      const redis: RedisConfig = {};
      if (process.env.REDIS_HOST !== undefined) redis.host = process.env.REDIS_HOST;
      if (process.env.REDIS_PORT !== undefined) redis.port = parseInteger(process.env.REDIS_PORT, 6379, 'REDIS_PORT');
      if (process.env.REDIS_PASSWORD !== undefined) redis.password = process.env.REDIS_PASSWORD;
      if (process.env.REDIS_DB !== undefined) redis.db = parseInteger(process.env.REDIS_DB, 0, 'REDIS_DB');
      if (process.env.REDIS_URL !== undefined) redis.url = process.env.REDIS_URL;
      config.databases.redis = redis;
    }

    // MongoDB 配置
    if (process.env.MONGODB_URL !== undefined || process.env.MONGODB_DATABASE !== undefined) {
      config.databases = config.databases || {};
      const mongodb: Partial<MongoDBConfig> = {};
      if (process.env.MONGODB_URL !== undefined) mongodb.url = process.env.MONGODB_URL;
      if (process.env.MONGODB_DATABASE !== undefined) mongodb.database = process.env.MONGODB_DATABASE;
      config.databases.mongodb = mongodb;
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
    const fileDatabases = fileConfig.databases;
    const envDatabases = envConfig.databases;
    const mysqlFile = fileDatabases?.mysql;
    const mysqlEnv = envDatabases?.mysql;
    const mysqlMerged = mysqlFile || mysqlEnv ? {
      ...mysqlFile,
      ...mysqlEnv,
      user: mysqlEnv?.user ?? mysqlFile?.user ?? 'root',
      password: mysqlEnv?.password ?? mysqlFile?.password ?? '',
      pool: mysqlFile?.pool || mysqlEnv?.pool || mysqlEnv?.host !== undefined
        ? { ...mysqlFile?.pool, ...mysqlEnv?.pool }
        : undefined,
    } : undefined;
    if (mysqlMerged && !mysqlMerged.host) {
      throw new Error('MySQL 配置缺少 host');
    }
    const mysql = mysqlMerged ? { ...mysqlMerged, host: mysqlMerged.host! } : undefined;
    const redis = fileDatabases?.redis || envDatabases?.redis
      ? { ...fileDatabases?.redis, ...envDatabases?.redis }
      : undefined;
    const mongodb = fileDatabases?.mongodb || envDatabases?.mongodb
      ? { ...fileDatabases?.mongodb, ...envDatabases?.mongodb }
      : undefined;
    if (mongodb && !mongodb.url) {
      throw new Error('MongoDB 配置缺少 url');
    }
    const databases: DatabaseConfig = {
      mysql,
      redis,
      mongodb: mongodb as MongoDBConfig | undefined,
    };

    // 合并配置，环境变量优先级更高
    const merged: AppConfig = {
      databases: Object.values(databases).some((value) => value !== undefined) ? databases : undefined,
      security: { ...fileConfig.security, ...envConfig.security },
      runtime: { ...fileConfig.runtime, ...envConfig.runtime },
    };
    const runtime = merged.runtime;
    if (runtime) {
      const positiveFields: Array<keyof NonNullable<AppConfig['runtime']>> = [
        'maxResultItems', 'maxResponseBytes', 'defaultMongoLimit', 'maxMongoLimit',
        'mysqlSelectLimit', 'maxConcurrentMySql', 'maxConcurrentRedis', 'maxConcurrentMongo',
      ];
      for (const field of positiveFields) {
        const value = runtime[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new Error(`运行配置 ${field} 必须是正整数`);
        }
      }
      if (runtime.maxResponseBytes !== undefined && runtime.maxResponseBytes < 20) {
        throw new Error('运行配置 maxResponseBytes 不能小于 20 字节');
      }
      if (runtime.operationTimeoutMs !== undefined &&
          (!Number.isSafeInteger(runtime.operationTimeoutMs) || runtime.operationTimeoutMs < 0)) {
        throw new Error('运行配置 operationTimeoutMs 必须是非负整数');
      }
    }
    return merged;
  }
}
