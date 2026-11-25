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
  private readonly initialMode: SecurityMode;
  private allowedOperations: Set<OperationType>;

  constructor(mode: SecurityMode = SecurityMode.READ_ONLY) {
    this.mode = mode;
    this.initialMode = mode;
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
    const statement = /^[A-Z]+\b/.exec(upperSQL)?.[0];
    
    // 只读模式：只允许 SELECT、SHOW、DESCRIBE、EXPLAIN
    if (this.mode === SecurityMode.READ_ONLY) {
      const readOnlyKeywords = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
      return statement !== undefined && readOnlyKeywords.includes(statement);
    }

    // 限制模式：原始 SQL 只开放查询和 INSERT；UPDATE/DELETE 使用结构化工具。
    if (this.mode === SecurityMode.RESTRICTED) {
      const allowedKeywords = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'INSERT'];
      return statement !== undefined && allowedKeywords.includes(statement);
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
    const rank: Record<SecurityMode, number> = {
      [SecurityMode.READ_ONLY]: 0,
      [SecurityMode.RESTRICTED]: 1,
      [SecurityMode.FULL_ACCESS]: 2,
    };
    if (rank[mode] > rank[this.initialMode]) {
      throw new Error(`不能超出初始安全模式（${this.initialMode}）提升权限；请修改启动配置并重启服务`);
    }
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
