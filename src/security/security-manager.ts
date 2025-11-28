/**
 * 安全模式枚举
 */
export enum SecurityMode {
  /** 只读模式：只允许查询操作，禁止所有修改操作 */
  READ_ONLY = 'read_only',
  /** 限制模式：允许查询和部分修改操作，禁止危险操作（如 DROP、DELETE 等） */
  RESTRICTED = 'restricted',
  /** 完全开发模式：允许所有操作 */
  FULL_ACCESS = 'full_access',
}

/**
 * 操作类型枚举
 */
export enum OperationType {
  // 查询操作
  QUERY = 'query',
  SELECT = 'select',
  GET = 'get',
  FIND = 'find',
  COUNT = 'count',
  LIST = 'list',
  KEYS = 'keys',
  EXISTS = 'exists',
  
  // 修改操作
  INSERT = 'insert',
  UPDATE = 'update',
  DELETE = 'delete',
  SET = 'set',
  
  // 危险操作
  DROP = 'drop',
  TRUNCATE = 'truncate',
  ALTER = 'alter',
  CREATE = 'create',
  EXECUTE = 'execute',
}

/**
 * 安全配置管理器
 */
export class SecurityManager {
  private mode: SecurityMode;
  private allowedOperations: Set<OperationType>;

  constructor(mode: SecurityMode = SecurityMode.READ_ONLY) {
    this.mode = mode;
    this.allowedOperations = this.getAllowedOperations(mode);
  }

  /**
   * 根据模式获取允许的操作
   */
  private getAllowedOperations(mode: SecurityMode): Set<OperationType> {
    switch (mode) {
      case SecurityMode.READ_ONLY:
        return new Set([
          OperationType.QUERY,
          OperationType.SELECT,
          OperationType.GET,
          OperationType.FIND,
          OperationType.COUNT,
          OperationType.LIST,
          OperationType.KEYS,
          OperationType.EXISTS,
        ]);

      case SecurityMode.RESTRICTED:
        return new Set([
          OperationType.QUERY,
          OperationType.SELECT,
          OperationType.GET,
          OperationType.FIND,
          OperationType.COUNT,
          OperationType.LIST,
          OperationType.KEYS,
          OperationType.EXISTS,
          OperationType.INSERT,
          OperationType.UPDATE,
          OperationType.SET,
        ]);

      case SecurityMode.FULL_ACCESS:
        return new Set(Object.values(OperationType));

      default:
        return new Set([OperationType.QUERY, OperationType.SELECT, OperationType.GET, OperationType.FIND]);
    }
  }

  /**
   * 检查操作是否被允许
   */
  isOperationAllowed(operation: OperationType): boolean {
    return this.allowedOperations.has(operation);
  }

  /**
   * 检查 SQL 语句是否被允许（用于 MySQL）
   */
  isSQLAllowed(sql: string): boolean {
    const upperSQL = sql.trim().toUpperCase();
    
    // 只读模式：只允许 SELECT、SHOW、DESCRIBE、EXPLAIN
    if (this.mode === SecurityMode.READ_ONLY) {
      const readOnlyKeywords = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
      return readOnlyKeywords.some(keyword => upperSQL.startsWith(keyword));
    }

    // 限制模式：禁止 DROP、TRUNCATE、ALTER TABLE、DELETE（无 WHERE）
    if (this.mode === SecurityMode.RESTRICTED) {
      const dangerousKeywords = ['DROP', 'TRUNCATE', 'ALTER TABLE'];
      if (dangerousKeywords.some(keyword => upperSQL.includes(keyword))) {
        return false;
      }
      
      // 检查 DELETE 是否有 WHERE 子句
      if (upperSQL.startsWith('DELETE')) {
        return upperSQL.includes('WHERE');
      }
      
      return true;
    }

    // 完全开发模式：允许所有操作
    return true;
  }

  /**
   * 获取当前安全模式
   */
  getMode(): SecurityMode {
    return this.mode;
  }

  /**
   * 设置安全模式
   */
  setMode(mode: SecurityMode): void {
    this.mode = mode;
    this.allowedOperations = this.getAllowedOperations(mode);
  }

  /**
   * 获取模式描述
   */
  getModeDescription(): string {
    switch (this.mode) {
      case SecurityMode.READ_ONLY:
        return '只读模式：只允许查询操作，禁止所有修改操作';
      case SecurityMode.RESTRICTED:
        return '限制模式：允许查询和部分修改操作，禁止危险操作（如 DROP、DELETE 等）';
      case SecurityMode.FULL_ACCESS:
        return '完全开发模式：允许所有操作';
      default:
        return '未知模式';
    }
  }
}

