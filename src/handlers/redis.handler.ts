import { RedisConfig, RedisConnector } from '../connectors/redis.js';
import { SecurityManager, OperationType } from '../security/security-manager.js';
import { buildSuccessResponse } from '../utils/response.js';
import { assertOperationAllowed } from '../utils/security.js';
import { assertRecord, assertString, getOptionalNumber, assertText } from '../utils/validation.js';

export class RedisHandler {
  private connector: RedisConnector | null = null;
  private securityManager: SecurityManager;

  constructor(securityManager: SecurityManager) {
    this.securityManager = securityManager;
  }

  setConnector(connector: RedisConnector | null) {
    this.connector = connector;
  }

  getConnector(): RedisConnector | null {
    return this.connector;
  }

  requireConnector(): RedisConnector {
    if (!this.connector) {
      throw new Error('Redis 未连接，请先使用 redis_connect 连接数据库');
    }
    return this.connector;
  }

  requireOperation(operation: OperationType) {
    assertOperationAllowed(this.securityManager, operation);
  }

  async handleConnect(args: Record<string, unknown>) {
    const rawArgs = assertRecord(args, 'redis_connect 参数');
    const redisConfig: RedisConfig = {};
    if (rawArgs.url !== undefined) {
      redisConfig.url = assertString(rawArgs.url, 'url');
    } else {
      redisConfig.host = assertString(rawArgs.host, 'host');
    }
    if (rawArgs.port !== undefined) {
      redisConfig.port = getOptionalNumber(rawArgs.port, 'port');
    }
    if (rawArgs.password !== undefined) {
      redisConfig.password = assertText(rawArgs.password, 'password');
    }
    if (rawArgs.db !== undefined) {
      redisConfig.db = getOptionalNumber(rawArgs.db, 'db');
    }
    const nextConnector = new RedisConnector(redisConfig);
    await nextConnector.connect();

    const previousConnector = this.connector;
    try {
      if (previousConnector) {
        await previousConnector.disconnect();
      }
      this.connector = nextConnector;
    } catch (error) {
      await nextConnector.disconnect().catch(() => undefined);
      throw error;
    }
    
    const parsedUrl = redisConfig.url ? new URL(redisConfig.url) : null;
    const host = parsedUrl?.hostname ?? redisConfig.host;
    const port = parsedUrl?.port || redisConfig.port || 6379;
    
    return buildSuccessResponse(`成功连接到 Redis 数据库: ${host}:${port}`);
  }

  async handleGet(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const { key } = assertRecord(args, 'redis_get 参数') as { key: unknown };
    const normalizedKey = assertString(key, 'key');
    const value = await connector.get(normalizedKey);
    return buildSuccessResponse(value === null ? `键 "${normalizedKey}" 不存在` : value);
  }

  async handleSet(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.SET);
    const rawArgs = assertRecord(args, 'redis_set 参数');
    const key = assertString(rawArgs.key, 'key');
    const value = assertString(rawArgs.value, 'value');
    const ttl = getOptionalNumber(rawArgs.ttl, 'ttl');
    await connector.set(key, value, ttl);
    return buildSuccessResponse(`成功设置键 "${key}"${ttl ? `，过期时间: ${ttl}秒` : ''}`);
  }

  async handleKeys(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'redis_keys 参数');
    const pattern = assertString(rawArgs.pattern, 'pattern');
    const count = getOptionalNumber(rawArgs.count, 'count') ?? 100;
    const limit = getOptionalNumber(rawArgs.limit, 'limit') ?? 500;
    const keys = await connector.scanKeys(pattern, count, limit);
    return buildSuccessResponse(keys);
  }

  async handleDelete(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.DELETE);
    const key = assertString(assertRecord(args, 'redis_del 参数').key, 'key');
    const deleted = await connector.del(key);
    return buildSuccessResponse(deleted > 0 ? `成功删除键 "${key}"` : `键 "${key}" 不存在`);
  }

  async handleHGet(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'redis_hget 参数');
    const key = assertString(rawArgs.key, 'key');
    const field = assertString(rawArgs.field, 'field');
    const value = await connector.hget(key, field);
    return buildSuccessResponse(value === undefined ? `字段 "${field}" 不存在` : value);
  }

  async handleHGetAll(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const key = assertString(assertRecord(args, 'redis_hgetall 参数').key, 'key');
    const result = await connector.hgetall(key);
    return buildSuccessResponse(result);
  }

  async handleDisconnect() {
    if (this.connector) {
      await this.connector.disconnect();
      this.connector = null;
      return buildSuccessResponse('已断开 Redis 数据库连接');
    }
    return buildSuccessResponse('Redis 数据库未连接');
  }
}
