import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SourceConfig } from '../config/v2.js';
import { maxRedisReadKeyBase64Length, maxRedisReadKeyBytes } from './redis-key.js';
import { mongoDatabasePattern, mysqlDatabasePattern } from './database-scope.js';

const sourceId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe('使用 list_sources 返回的数据源 ID，确认 enabledTools 包含本工具。');
const name = z.string().regex(/^[A-Za-z0-9_$]+$/).max(128);
export const mysqlIdentifierPattern = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_$]{1,128}$/;
export const mongoCollectionPattern = /^[A-Za-z0-9_.-]{1,128}$/;
// Each dotted component is an identifier. Reserve special JavaScript object keys in any component.
export const mongoFieldPattern = /^(?=.{1,128}$)(?!(?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:__proto__|constructor|prototype)(?:\.|$))[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// Publish policy restrictions in tools/list while keeping policy rejection on the
// existing SCOPE_DENIED path for callers that submit unsupported identifiers.
const mongoCollection = z.string().max(128).meta({ pattern: mongoCollectionPattern.source })
  .describe('目标数据库内 mongodb_list_collections 返回且符合命名规则的集合。');
const mongoField = z.string().max(128).meta({ pattern: mongoFieldPattern.source });
const scalar = z.union([z.string().max(4096), z.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.boolean(), z.null()]);
const mongoValue = z.union([scalar, z.object({ $oid: z.string().regex(/^[0-9a-fA-F]{24}$/) }).strict()]);
const redisReadKey = z.union([z.string().max(maxRedisReadKeyBytes),
  z.object({ base64: z.base64().max(maxRedisReadKeyBase64Length) }).strict()])
  .describe('UTF-8 文本或 {base64: "..."}，解码后最多 4096 字节。可直接传入 redis_keys 返回的 key。');
const limit = z.number().int().min(1).max(1000).optional()
  .describe('本次希望返回的最大行数。默认及实际最大值由 list_sources 的 maxRows 给出。');
const cursor = z.string().min(1).max(128).optional().describe('首页省略。续页原样传入上一页的 nextCursor，沿用同一源和查询范围。');
const sort = (field: z.ZodString) => z.array(z.object({ field, direction: z.enum(['asc', 'desc']) }).strict()).max(8).optional()
  .describe('按给定顺序使用授权字段排序。');
const mongoFields = z.array(mongoField).min(1).max(128).optional().describe('只返回需要的授权字段，允许点分路径。');
const mongoFilter = z.record(z.string().meta({ pattern: mongoFieldPattern.source }), mongoValue).optional()
  .describe('按授权字段做等值匹配。值为 JSON 标量或 {$oid: "24位十六进制"}。');
const scanPrefix = z.string().max(128).optional()
  .describe('allowlist 源须传入 list_sources.scanPrefixes 中的一个前缀，database 源可省略或传空字符串。');
const action = z.enum(['insert', 'update', 'delete']);
const expectedVersion = z.number().int().min(0).optional();
const operationId = z.string().uuid();
const databaseDescription = '省略时查询默认库。其他库仅在开启多库的源上可用，可用 list_databases 查找。';
const mysqlReadSource = { sourceId, database: z.string().regex(mysqlDatabasePattern).optional().describe(databaseDescription) };
const mongoReadSource = { sourceId, database: z.string().regex(mongoDatabasePattern).optional().describe(databaseDescription) };
const redisReadSource = { sourceId, database: z.number().int().min(0).max(15).optional().describe(databaseDescription) };

export const definitions: Array<{ name: string; description: string; engine?: SourceConfig['engine']; mutation?: 'journal' | 'database'; requiresWrite?: boolean; schema: z.ZodObject }> = [
  { name: 'list_sources', description: '查找数据源 ID、用途、可用状态、已启用工具、读取范围、行数上限和已启用的 Redis 扫描前缀。', schema: z.object({}).strict() },
  { name: 'list_databases', description: '分页列出多库数据源允许选择的数据库。MySQL 和 MongoDB 返回库名，Redis 返回库编号。',
    schema: z.object({ sourceId, limit, cursor }).strict() },
  { name: 'server_runtime_status', description: '只读服务的实例级资源额度与队列状态。', schema: z.object({}).strict() },
  { name: 'mysql_list_tables', engine: 'mysql', description: '分页列出目标数据库内可读取的表/视图，指定白名单时仅返回该范围。',
    schema: z.object({ ...mysqlReadSource, limit, cursor }).strict() },
  { name: 'mysql_select', engine: 'mysql', description: '在目标数据库的授权表/视图上进行参数化等值查询。不得传 SQL；JSON 列返回保留数字精度的原始 JSON 文本字符串。结果可能因预算截断。',
    schema: z.object({
      ...mysqlReadSource, table: name.describe('从 mysql_list_tables 选择表或视图。'),
      columns: z.array(name).min(1).max(128).optional().describe('只返回需要的授权列，可先调用 mysql_describe_table。'),
      where: z.record(z.string().meta({ pattern: mysqlIdentifierPattern.source }), scalar).optional()
        .describe('按授权列等值筛选，null 表示 SQL IS NULL。'),
      orderBy: sort(z.string().max(128).meta({ pattern: mysqlIdentifierPattern.source })), limit,
    }).strict() },
  { name: 'mysql_describe_table', engine: 'mysql', description: '分页读取授权表/视图的授权列元数据。', schema: z.object({ ...mysqlReadSource, table: name, limit, cursor }).strict() },
  { name: 'redis_get', engine: 'redis', description: '读取 Redis 字符串值的 Base64 起始片段。hasMore 为 true 时用 nextOffset 调用 redis_get_range。',
    schema: z.object({ ...redisReadSource, key: redisReadKey }).strict() },
  { name: 'redis_get_range', engine: 'redis', description: '按字节读取 Redis 字符串值的 Base64 片段。hasMore 为 false 时读到当前值的末尾。',
    schema: z.object({
      ...redisReadSource, key: redisReadKey,
      offset: z.number().int().min(0).default(0).describe('从零开始的字节偏移。续读时使用上次返回的 nextOffset。'),
      bytes: z.number().int().min(1).max(65536).optional().describe('期望的片段长度，实际长度受数据源预算限制。'),
    }).strict() },
  { name: 'redis_type', engine: 'redis', description: '返回精确授权 key 的类型。', schema: z.object({ ...redisReadSource, key: redisReadKey }).strict() },
  { name: 'redis_memory_usage', engine: 'redis', description: '返回精确授权 key 的内存估算；不遍历其他 key。', schema: z.object({ ...redisReadSource, key: redisReadKey }).strict() },
  { name: 'redis_keys', engine: 'redis', description: '分页扫描明确允许扫描的数据源。白名单模式使用配置的字面量前缀，全库模式使用空 prefix。',
    schema: z.object({ ...redisReadSource, prefix: scanPrefix, limit, cursor }).strict() },
  { name: 'mongodb_find', engine: 'mongodb', description: '查询目标数据库的集合；白名单模式限制集合及字段。filter 仅支持等值标量或 {$oid: "24位十六进制"}，不接受操作符/JavaScript。结果为保留 BSON 类型的 canonical Extended JSON。',
    schema: z.object({ ...mongoReadSource, collection: mongoCollection, filter: mongoFilter, fields: mongoFields, orderBy: sort(mongoField), limit }).strict() },
  { name: 'mongodb_find_one', engine: 'mongodb', description: '有界返回授权集合的至多一个文档，字段范围由服务端决定；结果为 canonical Extended JSON。',
    schema: z.object({ ...mongoReadSource, collection: mongoCollection, filter: mongoFilter, fields: mongoFields }).strict() },
  { name: 'mongodb_list_collections', engine: 'mongodb', description: '分页列出目标数据库内可读取的集合；白名单模式只返回已配置的集合。', schema: z.object({ ...mongoReadSource, limit, cursor }).strict() },
  { name: 'mysql_prepare_write', engine: 'mysql', requiresWrite: true, mutation: 'journal', description: '开发/测试：预览单目标写入并持久登记新操作；重复预览会生成新 ID。完整主键、版本和字段由服务端验证；预览不是人工审批或备份。',
    schema: z.object({ sourceId, table: name, action, key: z.record(z.string(), scalar), expectedVersion, values: z.record(z.string(), scalar).optional() }).strict() },
  { name: 'mongodb_prepare_write', engine: 'mongodb', requiresWrite: true, mutation: 'journal', description: '开发/测试：预览 _id 单文档事务写入并持久登记新操作；重复预览会生成新 ID。不接受 upsert、操作符或批量。',
    schema: z.object({ sourceId, collection: z.string().max(128), action, key: z.object({ _id: mongoValue }).strict(), expectedVersion, values: z.record(z.string(), scalar).optional() }).strict() },
  { name: 'redis_prepare_write', engine: 'redis', requiresWrite: true, mutation: 'journal', description: '开发/测试：预览精确字符串 key 写入并持久登记新操作；重复预览会生成新 ID。覆盖/删除必须提供预期值和 TTL 条件。固定服务端原子逻辑，不接受脚本。',
    schema: z.object({ sourceId, key: z.string().min(1).max(512), action: z.enum(['create', 'replace', 'delete']),
      value: z.string().max(4096).optional(), expectedValue: z.string().max(4096).optional(),
      ttl: z.discriminatedUnion('mode', [z.object({ mode: z.literal('keep') }).strict(), z.object({ mode: z.literal('clear') }).strict(),
        z.object({ mode: z.literal('expire'), seconds: z.number().int().min(1).max(604800) }).strict()]).optional(),
      expectedTtl: z.discriminatedUnion('mode', [z.object({ mode: z.literal('persistent') }).strict(),
        z.object({ mode: z.literal('expiring'), minMs: z.number().int().min(0).max(604800000), maxMs: z.number().int().min(1).max(604800000) }).strict()]).optional() }).strict() },
  { name: 'commit_write', requiresWrite: true, mutation: 'database', description: '仅执行未过期预览绑定的操作 ID 一次；不能改变参数。超时或确认丢失保持未知，禁止盲目重试。不是人工审批。', schema: z.object({ sourceId, operationId }).strict() },
  { name: 'operation_status', requiresWrite: true, description: '查询当前授权 source 的已登记操作；未知不通过读回猜测成功，不重放。', schema: z.object({ sourceId, operationId }).strict() },
];

export function sourceAllows(source: SourceConfig, toolName: string): boolean {
  if (source.access.allowedTools && !source.access.allowedTools.includes(toolName)) return false;
  if (toolName === 'list_databases') return source.databaseScope === 'visible';
  const tool = definitions.find(t => t.name === toolName);
  if (!tool?.engine || tool.engine !== source.engine) return false;
  if (tool.requiresWrite && (source.access.tier !== 'read_write' || !source.access.writes)) return false;
  return toolName !== 'redis_keys' || (source.engine === 'redis' && source.access.allowKeyspaceScan);
}

function sourceSupportsTool(source: SourceConfig, tool: (typeof definitions)[number]): boolean {
  return tool.engine || tool.name === 'list_databases' ? sourceAllows(source, tool.name) :
    tool.requiresWrite === true && sourceAllows(source, source.engine + '_prepare_write');
}

export function sourceToolMetadata(source: SourceConfig) {
  const enabledTools = definitions.filter(tool => sourceSupportsTool(source, tool)).map(tool => tool.name);
  return {
    enabledTools, readScope: source.access.readScope, maxRows: source.budgets.maxRows,
    ...(source.databaseScope === 'visible' ? { databaseScope: source.databaseScope, defaultDatabase: source.database } : {}),
    ...(source.engine === 'redis' && enabledTools.includes('redis_keys') ?
      { scanPrefixes: source.access.readScope === 'database' ? [''] : source.access.keyPrefixes } : {}),
  };
}

export function catalog(sources: readonly SourceConfig[]): Tool[] {
  return definitions.flatMap(tool => {
    const sourceIds = sources.filter(source => sourceSupportsTool(source, tool)).map(source => source.id);
    if ((tool.engine || tool.requiresWrite || tool.name === 'list_databases') && !sourceIds.length) return [];
    const inputSchema = z.toJSONSchema(tool.schema, { target: 'draft-07', io: 'input' }) as Tool['inputSchema'];
    const properties = inputSchema.properties;
    if (properties?.sourceId && typeof properties.sourceId === 'object') {
      properties.sourceId = { ...properties.sourceId, enum: sourceIds };
    }
    return [{
      name: tool.name, description: tool.description, inputSchema,
      annotations: { readOnlyHint: !tool.mutation, destructiveHint: tool.mutation === 'database',
        idempotentHint: !tool.mutation, openWorldHint: false },
    }];
  });
}
