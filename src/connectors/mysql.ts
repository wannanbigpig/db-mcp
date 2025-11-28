import mysql from 'mysql2/promise';

export interface MySQLConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  pool?: {
    min?: number;
    max?: number;
    idleTimeout?: number;
  };
}

export class MySQLConnector {
  private connection: mysql.Connection | null = null;
  private pool: mysql.Pool | null = null;
  private config: MySQLConfig;
  private usePool: boolean;

  constructor(config: MySQLConfig, usePool: boolean = false) {
    this.config = config;
    this.usePool = usePool && config.pool !== undefined;
  }

  async connect(): Promise<void> {
    try {
      const connectionConfig = {
        host: this.config.host,
        port: this.config.port || 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
      };

      if (this.usePool) {
        // 使用连接池
        this.pool = mysql.createPool({
          ...connectionConfig,
          waitForConnections: true,
          connectionLimit: this.config.pool?.max || 10,
          queueLimit: 0,
          idleTimeout: this.config.pool?.idleTimeout || 60000,
        });
      } else {
        // 使用单连接
        this.connection = await mysql.createConnection(connectionConfig);
      }
    } catch (error) {
      throw new Error(`MySQL 连接失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  async query(sql: string, params?: any[]): Promise<any> {
    if (this.usePool && this.pool) {
      try {
        const [rows] = await this.pool.execute(sql, params || []);
        return rows;
      } catch (error) {
        throw new Error(`MySQL 查询失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!this.connection) {
      throw new Error('MySQL 未连接，请先调用 connect()');
    }

    try {
      const [rows] = await this.connection.execute(sql, params || []);
      return rows;
    } catch (error) {
      throw new Error(`MySQL 查询失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取连接池状态
   */
  getPoolStats(): { totalConnections: number; activeConnections: number; idleConnections: number } | null {
    if (!this.usePool || !this.pool) {
      return null;
    }
    // mysql2 的 pool 没有直接的状态 API，这里返回基本信息
    return {
      totalConnections: this.config.pool?.max || 10,
      activeConnections: 0, // 需要从 pool 内部获取，这里简化处理
      idleConnections: 0,
    };
  }
}

