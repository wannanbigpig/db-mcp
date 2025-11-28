import { MongoClient, Db, Collection } from 'mongodb';

export interface MongoDBConfig {
  url: string;
  database?: string;
}

export class MongoDBConnector {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private config: MongoDBConfig;

  constructor(config: MongoDBConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(this.config.url);
      await this.client.connect();
      if (this.config.database) {
        this.db = this.client.db(this.config.database);
      } else {
        // 从 URL 中提取数据库名，如果没有则使用默认的 'test'
        const urlObj = new URL(this.config.url);
        const dbName = urlObj.pathname.slice(1) || 'test';
        this.db = this.client.db(dbName);
      }
    } catch (error) {
      throw new Error(`MongoDB 连接失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  getDatabase(): Db {
    if (!this.db) {
      throw new Error('MongoDB 未连接，请先调用 connect()');
    }
    return this.db;
  }

  getCollection(collectionName: string): Collection {
    return this.getDatabase().collection(collectionName);
  }

  async find(collectionName: string, filter: any = {}, options: any = {}): Promise<any[]> {
    const collection = this.getCollection(collectionName);
    const cursor = collection.find(filter, options);
    return await cursor.toArray();
  }

  async findOne(collectionName: string, filter: any = {}, options: any = {}): Promise<any | null> {
    const collection = this.getCollection(collectionName);
    return await collection.findOne(filter, options);
  }

  async insertOne(collectionName: string, document: any): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.insertOne(document);
  }

  async insertMany(collectionName: string, documents: any[]): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.insertMany(documents);
  }

  async updateOne(collectionName: string, filter: any, update: any): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.updateOne(filter, update);
  }

  async updateMany(collectionName: string, filter: any, update: any): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.updateMany(filter, update);
  }

  async deleteOne(collectionName: string, filter: any): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.deleteOne(filter);
  }

  async deleteMany(collectionName: string, filter: any): Promise<any> {
    const collection = this.getCollection(collectionName);
    return await collection.deleteMany(filter);
  }

  async countDocuments(collectionName: string, filter: any = {}): Promise<number> {
    const collection = this.getCollection(collectionName);
    return await collection.countDocuments(filter);
  }

  async listCollections(): Promise<string[]> {
    const db = this.getDatabase();
    const collections = await db.listCollections().toArray();
    return collections.map((col) => col.name);
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.db) {
        return false;
      }
      await this.db.admin().ping();
      return true;
    } catch {
      return false;
    }
  }
}

