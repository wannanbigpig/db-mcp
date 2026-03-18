import { MongoDBConfig, MongoDBConnector } from '../connectors/mongodb.js';
import { SecurityManager, OperationType } from '../security/security-manager.js';
import { buildSuccessResponse } from '../utils/response.js';
import { assertOperationAllowed } from '../utils/security.js';
import { assertArray, assertNonEmptyRecord, assertRecord, assertString, getOptionalNumber } from '../utils/validation.js';

interface MongoRuntimeOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

export class MongoDBHandler {
  private connector: MongoDBConnector | null = null;
  private securityManager: SecurityManager;
  private runtimeOptions: Required<MongoRuntimeOptions>;

  constructor(securityManager: SecurityManager, runtimeOptions: MongoRuntimeOptions = {}) {
    this.securityManager = securityManager;
    this.runtimeOptions = {
      defaultLimit: runtimeOptions.defaultLimit ?? 100,
      maxLimit: runtimeOptions.maxLimit ?? 500,
    };
  }

  setConnector(connector: MongoDBConnector | null) {
    this.connector = connector;
  }

  getConnector(): MongoDBConnector | null {
    return this.connector;
  }

  requireConnector(): MongoDBConnector {
    if (!this.connector) {
      throw new Error('MongoDB 未连接，请先使用 mongodb_connect 连接数据库');
    }
    return this.connector;
  }

  requireOperation(operation: OperationType) {
    assertOperationAllowed(this.securityManager, operation);
  }

  async handleConnect(args: Record<string, unknown>) {
    const rawArgs = assertRecord(args, 'mongodb_connect 参数');
    const mongodbConfig: MongoDBConfig = {
      url: assertString(rawArgs.url, 'url'),
    };
    if (rawArgs.database !== undefined) {
      mongodbConfig.database = assertString(rawArgs.database, 'database');
    }
    const nextConnector = new MongoDBConnector(mongodbConfig);
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
    return buildSuccessResponse(`成功连接到 MongoDB 数据库: ${mongodbConfig.url}`);
  }

  async handleFind(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'mongodb_find 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const filter = rawArgs.filter === undefined ? {} : assertRecord(rawArgs.filter, 'filter');
    const requestedLimit = getOptionalNumber(rawArgs.limit, 'limit');
    const skip = getOptionalNumber(rawArgs.skip, 'skip');
    const sort = rawArgs.sort === undefined ? undefined : assertRecord(rawArgs.sort, 'sort');
    const limit = requestedLimit === undefined
      ? this.runtimeOptions.defaultLimit
      : Math.min(requestedLimit, this.runtimeOptions.maxLimit);
    const options: Record<string, unknown> = {};
    if (limit !== undefined) options.limit = limit;
    if (skip !== undefined) options.skip = skip;
    if (sort) options.sort = sort;
    
    const result = await connector.find(collection, filter, options);
    return buildSuccessResponse(result);
  }

  async handleFindOne(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'mongodb_find_one 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const filter = rawArgs.filter === undefined ? {} : assertRecord(rawArgs.filter, 'filter');
    const result = await connector.findOne(collection, filter);
    return buildSuccessResponse(result === null ? '未找到匹配的文档' : result);
  }

  async handleInsertOne(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.INSERT);
    const rawArgs = assertRecord(args, 'mongodb_insert_one 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const document = assertNonEmptyRecord(rawArgs.document, 'document');
    const result = await connector.insertOne(collection, document);
    return buildSuccessResponse(result);
  }

  async handleInsertMany(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.INSERT);
    const rawArgs = assertRecord(args, 'mongodb_insert_many 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const documents = assertArray<Record<string, unknown>>(rawArgs.documents, 'documents');
    if (documents.length === 0) {
      throw new Error('documents 不能为空数组');
    }
    const result = await connector.insertMany(collection, documents);
    return buildSuccessResponse(result);
  }

  async handleUpdateOne(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.UPDATE);
    const rawArgs = assertRecord(args, 'mongodb_update_one 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const filter = assertRecord(rawArgs.filter, 'filter');
    const update = assertNonEmptyRecord(rawArgs.update, 'update');
    const result = await connector.updateOne(collection, filter, update);
    return buildSuccessResponse(result);
  }

  async handleDeleteOne(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.DELETE);
    const rawArgs = assertRecord(args, 'mongodb_delete_one 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const filter = assertRecord(rawArgs.filter, 'filter');
    const result = await connector.deleteOne(collection, filter);
    return buildSuccessResponse(result);
  }

  async handleCount(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'mongodb_count 参数');
    const collection = assertString(rawArgs.collection, 'collection');
    const filter = rawArgs.filter === undefined ? {} : assertRecord(rawArgs.filter, 'filter');
    const count = await connector.countDocuments(collection, filter);
    return buildSuccessResponse(`匹配的文档数量: ${count}`);
  }

  async handleListCollections() {
    const connector = this.requireConnector();
    const collections = await connector.listCollections();
    return buildSuccessResponse(collections);
  }

  async handleDisconnect() {
    if (this.connector) {
      await this.connector.disconnect();
      this.connector = null;
      return buildSuccessResponse('已断开 MongoDB 数据库连接');
    }
    return buildSuccessResponse('MongoDB 数据库未连接');
  }
}
