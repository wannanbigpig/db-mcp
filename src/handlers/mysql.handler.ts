import { MySQLConfig, MySQLConnector } from '../connectors/mysql.js';
import { SecurityManager, OperationType } from '../security/security-manager.js';
import { buildSuccessResponse } from '../utils/response.js';
import { assertOperationAllowed } from '../utils/security.js';
import { buildAssignments, buildInsert, buildWhereClause, escapeIdentifier } from '../utils/mysql.js';
import { assertNonEmptyRecord, assertRecord, assertString, assertArray, getOptionalNumber, assertText } from '../utils/validation.js';

interface MySQLHandlerRuntimeOptions {
  selectLimit?: number;
  hasPreconfiguredConnection?: boolean;
}

export class MySQLHandler {
  private connector: MySQLConnector | null = null;
  private securityManager: SecurityManager;
  private runtimeOptions: Required<MySQLHandlerRuntimeOptions>;

  constructor(securityManager: SecurityManager, runtimeOptions: MySQLHandlerRuntimeOptions = {}) {
    this.securityManager = securityManager;
    this.runtimeOptions = {
      selectLimit: runtimeOptions.selectLimit ?? 500,
      hasPreconfiguredConnection: runtimeOptions.hasPreconfiguredConnection ?? false,
    };
  }

  setConnector(connector: MySQLConnector | null) {
    this.connector = connector;
  }

  getConnector(): MySQLConnector | null {
    return this.connector;
  }

  requireConnector(): MySQLConnector {
    if (!this.connector) {
      if (this.runtimeOptions.hasPreconfiguredConnection) {
        throw new Error(
          'MySQL 默认连接当前不可用。若这是启动时的预配置连接，请先调用 server_runtime_status 检查 connections.mysql 状态；仅在需要覆盖默认连接或手动重连时再使用 mysql_connect。'
        );
      }
      throw new Error('MySQL 未连接。若服务启动时未预配置 MySQL，请先使用 mysql_connect 建立连接。');
    }
    return this.connector;
  }

  requireOperation(operation: OperationType) {
    assertOperationAllowed(this.securityManager, operation);
  }

  async handleConnect(args: Record<string, unknown>) {
    const rawConfig = assertRecord(args, 'mysql_connect 参数');
    const mysqlConfig: MySQLConfig & { usePool?: boolean } = {
      host: assertString(rawConfig.host, 'host'),
      user: assertString(rawConfig.user, 'user'),
      password: assertText(rawConfig.password, 'password'),
    };
    if (rawConfig.port !== undefined) {
      mysqlConfig.port = getOptionalNumber(rawConfig.port, 'port');
    }
    if (rawConfig.database !== undefined) {
      mysqlConfig.database = assertString(rawConfig.database, 'database');
    }
    if (rawConfig.pool !== undefined) {
      mysqlConfig.pool = assertRecord(rawConfig.pool, 'pool') as MySQLConfig['pool'];
    }
    if (rawConfig.usePool !== undefined) {
      mysqlConfig.usePool = rawConfig.usePool === true;
    }
    const usePool = mysqlConfig.usePool === true && mysqlConfig.pool !== undefined;
    const nextConnector = new MySQLConnector(mysqlConfig, usePool, {
      selectLimit: this.runtimeOptions.selectLimit,
    });
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
    
    return buildSuccessResponse(
      `成功连接到 MySQL 数据库: ${mysqlConfig.host}:${mysqlConfig.port || 3306}${usePool ? '（使用连接池）' : ''}`
    );
  }

  async handleQuery(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    const rawArgs = assertRecord(args, 'mysql_query 参数');
    const sql = assertString(rawArgs.sql, 'sql');
    const params = rawArgs.params === undefined ? undefined : assertArray<unknown>(rawArgs.params, 'params');

    if (!this.securityManager.isSQLAllowed(sql)) {
      throw new Error(
        `当前安全模式（${this.securityManager.getMode()}）不允许执行此 SQL 语句。\n` +
        `允许的操作：${this.securityManager.getModeDescription()}`
      );
    }

    const result = await connector.query(sql, params);
    return buildSuccessResponse(result);
  }

  async handleDisconnect() {
    if (this.connector) {
      await this.connector.disconnect();
      this.connector = null;
      return buildSuccessResponse('已断开 MySQL 数据库连接');
    }
    return buildSuccessResponse('MySQL 数据库未连接');
  }

  handlePoolStatus() {
    const connector = this.requireConnector();
    const poolStats = connector.getPoolStats();
    if (!poolStats) {
      return buildSuccessResponse('当前未使用连接池');
    }
    return buildSuccessResponse(poolStats);
  }

  async handleInsert(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.INSERT);
    
    const rawArgs = assertRecord(args, 'mysql_insert 参数');
    const table = escapeIdentifier(assertString(rawArgs.table, 'table'), 'table');
    const data = assertNonEmptyRecord(rawArgs.data, 'data');
    const insert = buildInsert(data, 'data');
    const sql = `INSERT INTO ${table} (${insert.columns}) VALUES (${insert.placeholders})`;
    
    const result = await connector.query(sql, insert.values);
    return buildSuccessResponse(result);
  }

  async handleUpdate(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.UPDATE);
    
    const rawArgs = assertRecord(args, 'mysql_update 参数');
    const table = escapeIdentifier(assertString(rawArgs.table, 'table'), 'table');
    const data = assertNonEmptyRecord(rawArgs.data, 'data');
    const where = assertNonEmptyRecord(rawArgs.where, 'where');
    const assignments = buildAssignments(data, 'data');
    const whereClause = buildWhereClause(where, 'where');
    const params = [...assignments.values, ...whereClause.values];
    const sql = `UPDATE ${table} SET ${assignments.clause} WHERE ${whereClause.clause}`;
    
    const result = await connector.query(sql, params);
    return buildSuccessResponse(result);
  }

  async handleDelete(args: Record<string, unknown>) {
    const connector = this.requireConnector();
    this.requireOperation(OperationType.DELETE);
    
    const rawArgs = assertRecord(args, 'mysql_delete 参数');
    const table = escapeIdentifier(assertString(rawArgs.table, 'table'), 'table');
    const where = assertNonEmptyRecord(rawArgs.where, 'where');
    const whereClause = buildWhereClause(where, 'where');
    const sql = `DELETE FROM ${table} WHERE ${whereClause.clause}`;
    
    const result = await connector.query(sql, whereClause.values);
    return buildSuccessResponse(result);
  }
}
