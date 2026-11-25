export const errorMessages = {
  INVALID_CONFIG: '配置不符合安全 v2 契约',
  SECRET_UNAVAILABLE: '秘密引用不可用或文件权限不安全',
  SOURCE_UNAVAILABLE: '数据源不可用',
  REDIS_WRONG_TYPE: 'Redis key 类型与工具不匹配，请先调用 redis_type',
  SSH_UNAVAILABLE: 'SSH 通道不可用，请检查服务器、认证及转发权限',
  SSH_AUTH_FAILED: 'SSH 服务器拒绝认证，请检查跳板机账号或凭证',
  DATABASE_AUTH_FAILED: '数据库拒绝认证或启动探测权限',
  DATABASE_TLS_INVALID: '数据库 TLS 证书校验失败',
  SSH_HOST_KEY_MISMATCH: 'SSH 主机密钥校验失败，请检查本机已知主机或已配置的指纹',
  SCOPE_DENIED: '工具或数据范围未获授权',
  INVALID_ARGUMENT: '请求参数不符合工具契约',
  BUDGET_EXCEEDED: '请求超过资源预算',
  QUERY_REQUIRES_INDEX: '此数据源要求可确认使用索引的读取计划',
  BSON_DATE_OUT_OF_RANGE: '查询结果含超出 JavaScript Date 范围的 BSON 日期',
  REQUEST_CANCELLED: '请求已取消或超时',
  SERVER_CLOSED: '服务已停止接受请求',
  JOURNAL_UNAVAILABLE: '操作记录不可用；新的写入已关闭',
  OPERATION_NOT_FOUND: '操作不存在、已过期或不属于当前授权数据源',
  PREVIEW_EXPIRED: '预览已过期或已失去执行上下文',
  VERSION_CONFLICT: '目标存在性、版本、预期值或 TTL 条件不匹配',
  VERSION_LIMIT_REACHED: '记录版本已达到 JavaScript 安全整数上限，无法继续递增',
  TARGET_NOT_FOUND: '授权范围内的目标记录或 key 不存在',
  WRITE_REJECTED: '数据库拒绝本次写入，已确认未生效',
  SCHEMA_UNSAFE: '真实对象、索引或间接影响不满足写入前置条件',
  SCHEMA_CHANGED: '预览后的数据库元数据发生变化',
  WRITE_OUTCOME_UNKNOWN: '写入结果未知，禁止盲目重试',
} as const;

export type ErrorCode = keyof typeof errorMessages;

const detailedErrors = {
  invalid_shape: { message: '请求参数结构不符合工具契约，请检查嵌套和字段数量', nextAction: 'check_arguments' },
  invalid_type: { message: '参数类型不符合工具契约，请检查所需类型和必填项', nextAction: 'check_arguments' },
  invalid_value: { message: '参数值不符合工具契约，请检查工具参数要求', nextAction: 'check_arguments' },
  invalid_sort_direction: { message: '排序方向只接受 asc 或 desc', nextAction: 'check_arguments' },
  unknown_field: { message: '请求包含工具未定义的参数，请对照工具参数列表', nextAction: 'check_arguments' },
  out_of_range: { message: '参数超出工具允许的大小或取值范围', nextAction: 'check_arguments' },
  invalid_cursor: { message: '续页游标不可用，请在相同的查询范围从首页开始', nextAction: 'restart_pagination' },
  scan_prefix_denied: { message: '扫描前缀未获授权，请查看 list_sources 返回的 scanPrefixes', nextAction: 'check_scan_prefixes' },
  database_selection_disabled: { message: '该数据源只开放默认库，请省略 database', nextAction: 'check_arguments' },
  database_denied: { message: '数据库不可用于此数据源，请用默认库或从 list_databases 选择已授权的库', nextAction: 'check_databases' },
  request_too_large: { message: '请求参数超过字节预算，请缩小参数', nextAction: 'reduce_request' },
  response_too_large: { message: '结果超过响应字节预算', nextAction: 'narrow_query' },
  item_too_large: { message: '单项结果超过字节预算，请缩小读取范围或联系管理员', nextAction: 'narrow_query' },
  queue_full: { message: '执行队列已满', nextAction: 'retry_read_later' },
  queue_timeout: { message: '等待执行额度超时', nextAction: 'retry_read_later' },
  caller_cancelled: { message: '调用方已取消请求' },
  query_timeout: { message: '操作超过总时限', nextAction: 'narrow_query' },
  source_reconnecting: { message: '数据源正在连接或恢复，请通过 list_sources 查看状态', nextAction: 'check_source_status' },
  source_unavailable: { message: '数据源当前不可用，请通过 list_sources 查看状态', nextAction: 'check_source_status' },
  source_connection_lost: { message: '数据库连接中断或未能建立，请检查数据源状态', nextAction: 'check_source_status' },
  query_rejected: { message: '数据库拒绝本次读取，请检查查询参数、可读范围或数据库授权', nextAction: 'check_query' },
} as const;

type ErrorDetails = { reason: keyof typeof detailedErrors; path?: string } |
  { reason: 'UNSAFE_INTEGER'; path: string };

export class SafeError extends Error {
  constructor(public readonly code: ErrorCode, public readonly details?: ErrorDetails) {
    super(`${code}: ${details && details.reason !== 'UNSAFE_INTEGER' ? detailedErrors[details.reason].message : errorMessages[code]}`);
    this.name = 'SafeError';
  }
}

export function clientErrorDetails(error: SafeError, readOnly: boolean) {
  const details = error.details;
  if (!details || !readOnly || details.reason === 'UNSAFE_INTEGER') return details;
  const guidance = detailedErrors[details.reason];
  return 'nextAction' in guidance ? { ...details, nextAction: guidance.nextAction } : details;
}

export function safeError(error: unknown): SafeError {
  return error instanceof SafeError ? error : new SafeError('SOURCE_UNAVAILABLE');
}

const mysqlReadRejections = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_VIEW_INVALID', 'ER_SPECIFIC_ACCESS_DENIED_ERROR']);
const networkFailures = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT']);

// Called only after an authorized read. Collapse schema and permission errors
// to the same advice so it cannot disclose which database object exists.
export function readError(error: unknown, engine: 'mysql' | 'redis' | 'mongodb'): SafeError {
  if (error instanceof Error && !(error instanceof SafeError)) {
    const code = 'code' in error ? error.code : undefined;
    const mysqlRejected = engine === 'mysql' && typeof code === 'string' && mysqlReadRejections.has(code);
    const mongoRejected = engine === 'mongodb' && error.name === 'MongoServerError' && (code === 13 || code === 26);
    if (mysqlRejected || mongoRejected) return new SafeError('SOURCE_UNAVAILABLE', { reason: 'query_rejected' });
    if ((typeof code === 'string' && networkFailures.has(code)) ||
        (engine === 'mysql' && (code === 'PROTOCOL_CONNECTION_LOST' || code === 'ER_SERVER_SHUTDOWN')) ||
        (engine === 'mongodb' && error.name === 'MongoNetworkError')) {
      return new SafeError('SOURCE_UNAVAILABLE', { reason: 'source_connection_lost' });
    }
  }
  return safeError(error);
}

const tlsCertificateCodes = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'INVALID_CA',
]);
const mysqlAuthCodes = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_ACCOUNT_HAS_BEEN_LOCKED', 'ER_HOST_NOT_PRIVILEGED', 'ER_HOST_IS_BLOCKED', 'ER_MUST_CHANGE_PASSWORD_LOGIN']);

export function connectionError(error: unknown, engine: 'mysql' | 'redis' | 'mongodb'): SafeError {
  if (error instanceof SafeError) return error;
  // Mongo may put its TLS error inside a cause or a server selection description.
  const pending = [error];
  const examined = new Set<object>();
  const add = (entry: unknown) => {
    if (entry && typeof entry === 'object' && !examined.has(entry) && pending.length < 16) pending.push(entry);
  };
  for (const entry of pending) {
    if (!entry || typeof entry !== 'object' || examined.has(entry)) continue;
    examined.add(entry);
    const { code, message, cause, reason, error: nested, servers } = entry as {
      code?: unknown; message?: unknown; cause?: unknown; reason?: unknown; error?: unknown; servers?: unknown;
    };
    const mysqlCertificateFailure = engine === 'mysql' && code === 'HANDSHAKE_SSL_ERROR' && typeof message === 'string' &&
      /hostname\/ip does not match certificate|certificate (?:has expired|is not yet valid|revoked)|self[- ]signed certificate|unable to (?:verify the first certificate|get (?:local )?issuer certificate)/i.test(message);
    if (mysqlCertificateFailure || (engine === 'mysql' && code === 'HANDSHAKE_NO_SSL_SUPPORT') ||
        (typeof code === 'string' && tlsCertificateCodes.has(code))) return new SafeError('DATABASE_TLS_INVALID');
    if ((engine === 'mysql' && typeof code === 'string' && mysqlAuthCodes.has(code)) ||
        (engine === 'mongodb' && (code === 18 || code === 13)) ||
        (engine === 'redis' && typeof message === 'string' &&
          /^(?:(?:WRONGPASS|NOAUTH|NOPERM)(?: |$)|ERR AUTH .*called without any password configured)/.test(message))) {
      return new SafeError('DATABASE_AUTH_FAILED');
    }
    add(cause); add(reason); add(nested);
    if (servers instanceof Map) for (const value of servers.values()) add(value);
  }
  return new SafeError('SOURCE_UNAVAILABLE');
}
