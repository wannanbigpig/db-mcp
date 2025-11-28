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
        port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE,
        pool: {
          min: process.env.MYSQL_POOL_MIN ? parseInt(process.env.MYSQL_POOL_MIN) : 2,
          max: process.env.MYSQL_POOL_MAX ? parseInt(process.env.MYSQL_POOL_MAX) : 10,
          idleTimeout: process.env.MYSQL_POOL_IDLE_TIMEOUT ? parseInt(process.env.MYSQL_POOL_IDLE_TIMEOUT) : 60000,
        },
      };
    }

    // Redis 配置
    if (process.env.REDIS_HOST || process.env.REDIS_URL) {
      config.databases = config.databases || {};
      config.databases.redis = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : 0,
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

    return config;
  }

  /**
   * 加载配置（优先从文件，然后从环境变量）
   */
  static load(): AppConfig {
    const fileConfig = this.loadFromFile();
    const envConfig = this.loadFromEnv();

    // 合并配置，环境变量优先级更高
    return {
      databases: {
        ...fileConfig.databases,
        ...envConfig.databases,
        mysql: envConfig.databases?.mysql || fileConfig.databases?.mysql,
        redis: envConfig.databases?.redis || fileConfig.databases?.redis,
        mongodb: envConfig.databases?.mongodb || fileConfig.databases?.mongodb,
      },
      security: envConfig.security || fileConfig.security,
    };
  }
}

