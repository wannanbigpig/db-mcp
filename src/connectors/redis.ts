import { createClient, RedisClientType } from 'redis';

export interface RedisConfig {
  host?: string;
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
      if (this.client.isOpen) {
        await this.client.quit();
      }
      this.client = null;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.get(key);
  }

  async type(key: string): Promise<string> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.sendCommand<string>(['TYPE', key]);
  }

  async memoryUsage(key: string): Promise<number | null> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    return await this.client.sendCommand<number | null>(['MEMORY', 'USAGE', key]);
  }

  private async scanMemoryEntries(
    pattern: string,
    count: number,
    maxKeys: number
  ): Promise<{
    scannedKeys: number;
    scanCapped: boolean;
    entries: Array<{ key: string; bytes: number }>;
  }> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }

    const batchSize = Math.min(count, 50);
    const entries: Array<{ key: string; bytes: number }> = [];
    let scannedKeys = 0;
    let scanCapped = false;
    let batch: string[] = [];

    const flushBatch = async () => {
      if (batch.length === 0) {
        return;
      }

      const usageEntries = await Promise.all(
        batch.map(async (key) => ({
          key,
          bytes: await this.memoryUsage(key),
        }))
      );

      for (const entry of usageEntries) {
        if (entry.bytes !== null) {
          entries.push({ key: entry.key, bytes: entry.bytes });
        }
      }

      batch = [];
    };

    for await (const key of this.client.scanIterator({
      MATCH: pattern,
      COUNT: count,
    })) {
      scannedKeys += 1;
      batch.push(key);

      if (batch.length >= batchSize) {
        await flushBatch();
      }

      if (scannedKeys >= maxKeys) {
        scanCapped = true;
        break;
      }
    }

    await flushBatch();

    return {
      scannedKeys,
      scanCapped,
      entries,
    };
  }

  async topMemoryKeys(options?: {
    pattern?: string;
    count?: number;
    maxKeys?: number;
    topN?: number;
  }): Promise<{
    pattern: string;
    scannedKeys: number;
    scanCapped: boolean;
    topN: number;
    items: Array<{ key: string; bytes: number; type: string }>;
  }> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }

    const pattern = options?.pattern ?? '*';
    const count = options?.count ?? 100;
    const maxKeys = options?.maxKeys ?? 5000;
    const topN = options?.topN ?? 20;
    const { scannedKeys, scanCapped, entries } = await this.scanMemoryEntries(pattern, count, maxKeys);

    const topItems = entries
      .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key))
      .slice(0, topN);

    const items = await Promise.all(
      topItems.map(async (item) => ({
        ...item,
        type: await this.type(item.key),
      }))
    );

    return {
      pattern,
      scannedKeys,
      scanCapped,
      topN,
      items,
    };
  }

  async memoryUsageByPrefixes(options: {
    prefixes: string[];
    count?: number;
    maxKeysPerPrefix?: number;
  }): Promise<{
    groups: Array<{
      pattern: string;
      scannedKeys: number;
      scanCapped: boolean;
      matchedKeys: number;
      totalBytes: number;
      largestKey: string | null;
      largestKeyBytes: number | null;
    }>;
  }> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }

    const count = options.count ?? 100;
    const maxKeysPerPrefix = options.maxKeysPerPrefix ?? 5000;
    const groups = await Promise.all(
      options.prefixes.map(async (pattern) => {
        const { scannedKeys, scanCapped, entries } = await this.scanMemoryEntries(
          pattern,
          count,
          maxKeysPerPrefix
        );
        const largest = entries
          .slice()
          .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key))[0];

        return {
          pattern,
          scannedKeys,
          scanCapped,
          matchedKeys: entries.length,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          largestKey: largest?.key ?? null,
          largestKeyBytes: largest?.bytes ?? null,
        };
      })
    );

    groups.sort((a, b) => b.totalBytes - a.totalBytes || a.pattern.localeCompare(b.pattern));

    return { groups };
  }

  async autoPrefixMemoryUsage(options?: {
    pattern?: string;
    separator?: string;
    depth?: number;
    count?: number;
    maxKeys?: number;
    topN?: number;
  }): Promise<{
    pattern: string;
    separator: string;
    depth: number;
    scannedKeys: number;
    scanCapped: boolean;
    topN: number;
    groups: Array<{
      prefix: string;
      matchedKeys: number;
      totalBytes: number;
      largestKey: string | null;
      largestKeyBytes: number | null;
    }>;
  }> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }

    const pattern = options?.pattern ?? '*';
    const separator = options?.separator ?? ':';
    const depth = options?.depth ?? 1;
    const count = options?.count ?? 100;
    const maxKeys = options?.maxKeys ?? 5000;
    const topN = options?.topN ?? 20;
    const { scannedKeys, scanCapped, entries } = await this.scanMemoryEntries(pattern, count, maxKeys);
    const groups = new Map<
      string,
      {
        prefix: string;
        matchedKeys: number;
        totalBytes: number;
        largestKey: string | null;
        largestKeyBytes: number | null;
      }
    >();

    for (const entry of entries) {
      const prefix = buildAutoPrefix(entry.key, separator, depth);
      const current = groups.get(prefix) ?? {
        prefix,
        matchedKeys: 0,
        totalBytes: 0,
        largestKey: null,
        largestKeyBytes: null,
      };

      current.matchedKeys += 1;
      current.totalBytes += entry.bytes;
      if (
        current.largestKeyBytes === null ||
        entry.bytes > current.largestKeyBytes ||
        (entry.bytes === current.largestKeyBytes && current.largestKey !== null && entry.key.localeCompare(current.largestKey) < 0)
      ) {
        current.largestKey = entry.key;
        current.largestKeyBytes = entry.bytes;
      }

      groups.set(prefix, current);
    }

    return {
      pattern,
      separator,
      depth,
      scannedKeys,
      scanCapped,
      topN,
      groups: Array.from(groups.values())
        .sort((a, b) => b.totalBytes - a.totalBytes || a.prefix.localeCompare(b.prefix))
        .slice(0, topN),
    };
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

  async scanKeys(pattern: string, count: number = 100, limit: number = 500): Promise<string[]> {
    if (!this.client) {
      throw new Error('Redis 未连接，请先调用 connect()');
    }
    const keys: string[] = [];

    for await (const key of this.client.scanIterator({
      MATCH: pattern,
      COUNT: count,
    })) {
      keys.push(key);
      if (keys.length >= limit) {
        break;
      }
    }

    return keys;
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

function buildAutoPrefix(key: string, separator: string, depth: number): string {
  if (!key.includes(separator)) {
    return key;
  }

  const parts = key.split(separator);
  const prefixParts = parts.slice(0, Math.min(depth, parts.length));
  return prefixParts.length < parts.length
    ? `${prefixParts.join(separator)}${separator}*`
    : prefixParts.join(separator);
}
