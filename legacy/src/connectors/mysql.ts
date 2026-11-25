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

export interface MySQLRuntimeOptions {
  selectLimit?: number;
}

export class MySQLConnector {
  private connection: mysql.Connection | null = null;
  private pool: mysql.Pool | null = null;
  private config: MySQLConfig;
  private usePool: boolean;
  private runtimeOptions: MySQLRuntimeOptions;

  constructor(config: MySQLConfig, usePool: boolean = false, runtimeOptions: MySQLRuntimeOptions = {}) {
    this.config = config;
    this.usePool = usePool && config.pool !== undefined;
    this.runtimeOptions = runtimeOptions;
  }

  private async queryWithPromiseCompatibility(
    connection: mysql.Connection | mysql.PoolConnection | {
      query: (...args: unknown[]) => unknown;
      promise?: () => {
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
      };
    },
    sql: string,
    params?: unknown[]
  ): Promise<void> {
    if ('promise' in connection && typeof connection.promise === 'function') {
      await connection.promise().query(sql, params);
      return;
    }

    await (connection as mysql.Connection | mysql.PoolConnection).query(sql, params);
  }

  private async applySessionSettings(
    connection: mysql.Connection | mysql.PoolConnection | {
      query: (...args: unknown[]) => unknown;
      promise?: () => {
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
      };
    }
  ): Promise<void> {
    if (this.runtimeOptions.selectLimit !== undefined) {
      await this.queryWithPromiseCompatibility(
        connection,
        'SET SESSION SQL_SELECT_LIMIT = ?',
        [this.runtimeOptions.selectLimit]
      );
    }
  }

  async connect(): Promise<void> {
    try {
      const connectionConfig = {
        host: this.config.host,
        port: this.config.port || 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        enableKeepAlive: true,
        connectTimeout: 10000,
      };

      if (this.usePool) {
        // 使用连接池
        this.pool = mysql.createPool({
          ...connectionConfig,
          waitForConnections: true,
          connectionLimit: this.config.pool?.max || 10,
          maxIdle: this.config.pool?.min || 2,
          queueLimit: 0,
          idleTimeout: this.config.pool?.idleTimeout || 60000,
          keepAliveInitialDelay: 10000,
        });
        // createPool 是惰性连接，主动 ping 一次可在 connect 阶段尽早暴露配置错误。
        const connection = await this.pool.getConnection();
        try {
          await this.applySessionSettings(connection);
          await this.queryWithPromiseCompatibility(connection, 'SELECT 1');
        } finally {
          connection.release();
        }
      } else {
        // 使用单连接
        this.connection = await mysql.createConnection(connectionConfig);
        await this.applySessionSettings(this.connection);
      }
    } catch (error) {
      await this.disconnect().catch(() => undefined);
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

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    if (this.usePool && this.pool) {
      const connection = await this.pool.getConnection();
      try {
        await this.applySessionSettings(connection);
        const [rows] = await connection.execute(sql, (params || []) as mysql.ExecuteValues);
        return rows;
      } catch (error) {
        throw new Error(`MySQL 查询失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        connection.release();
      }
    }

    if (!this.connection) {
      throw new Error('MySQL 未连接，请先调用 connect()');
    }

    try {
      const [rows] = await this.connection.execute(sql, (params || []) as mysql.ExecuteValues);
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
  getPoolStats():
    | {
        totalConnections: number;
        activeConnections: number;
        idleConnections: number;
        queuedRequests: number;
        configuredMaxConnections: number;
        selectLimit: number | null;
      }
    | null {
    if (!this.usePool || !this.pool) {
      return null;
    }
    const poolInternal = (this.pool as unknown as { pool?: unknown }).pool as {
      _allConnections?: { length: number };
      _freeConnections?: { length: number };
      _connectionQueue?: { length: number };
    } | undefined;
    const configuredMaxConnections = this.config.pool?.max || 10;
    const totalConnections = poolInternal?._allConnections?.length ?? 0;
    const idleConnections = poolInternal?._freeConnections?.length ?? 0;
    const activeConnections = Math.max(totalConnections - idleConnections, 0);
    const queuedRequests = poolInternal?._connectionQueue?.length ?? 0;

    return {
      totalConnections,
      activeConnections,
      idleConnections,
      queuedRequests,
      configuredMaxConnections,
      selectLimit: this.runtimeOptions.selectLimit ?? null,
    };
  }
}
