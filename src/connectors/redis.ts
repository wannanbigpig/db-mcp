import { createClient, RedisClientType } from 'redis';

export interface RedisConfig {
  host: string;
  port?: number;
  password?: string;
  db?: number;
  url?: string;
}

export class RedisConnector {
  private client: RedisClientType | null = null;
  private config: RedisConfig;
  private lastError: string | null = null;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      if (this.config.url) {
        this.client = createClient({ url: this.config.url });
      } else {
        this.client = createClient({
          socket: {
            host: this.config.host,
            port: this.config.port || 6379,
          },
          password: this.config.password,
          database: this.config.db || 0,
        });
      }

      this.client.on('error', (err: Error) => {
        // 不能在事件回调内抛错，否则会导致整个 MCP 进程退出。
        this.lastError = err.message;
      });

      await this.client.connect();
    } catch (error) {
      throw new Error(`Redis 连接失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    if (ttl) {
      await this.client.setEx(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.keys(pattern);
  }

  async exists(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.exists(key);
  }

  async hget(key: string, field: string): Promise<string | undefined> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.hGet(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.hGetAll(key);
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.client) {
        return false;
      }
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
