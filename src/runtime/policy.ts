import type { SourceConfig } from '../config/v2.js';
import { SafeError } from './errors.js';
import { parseRedisReadKey } from './redis-key.js';
import type { ListPosition } from './pagination.js';
import { mongoCollectionPattern, mongoFieldPattern, mysqlIdentifierPattern, sourceAllows } from './tool-catalog.js';
import { databaseDenied, databaseExcluded, redisDatabases, type Database } from './database-scope.js';

export type ReadPlan = {
  tool: string; database?: Database; target?: string; fields?: string[]; filter?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number; position?: ListPosition; prefix?: string; redisKey?: Buffer; offset?: number; bytes?: number;
};

export function authorize(source: SourceConfig, tool: string, args: Record<string, unknown>): ReadPlan {
  if (!sourceAllows(source, tool)) throw new SafeError('SCOPE_DENIED');
  const plan: ReadPlan = { tool, limit: Math.min((args.limit as number | undefined) ?? source.budgets.maxRows, source.budgets.maxRows) };
  if (tool === 'list_databases') return plan;
  const database = args.database;
  if (database !== undefined && database !== source.database) {
    if (source.databaseScope !== 'visible') throw new SafeError('INVALID_ARGUMENT', { reason: 'database_selection_disabled', path: '$.database' });
    if (source.engine === 'redis' ? typeof database !== 'number' || !redisDatabases(source).includes(database) :
      typeof database !== 'string' || databaseExcluded(source, database)) throw databaseDenied();
    plan.database = database as Database;
  }
  if (source.engine === 'mysql' || source.engine === 'mongodb') {
    if (tool === 'mongodb_list_collections' || tool === 'mysql_list_tables') return plan;
    const target = source.engine === 'mysql' ? args.table : args.collection;
    if (typeof target !== 'string' || (source.engine === 'mysql' ? !mysqlIdentifierPattern.test(target) :
      !mongoCollectionPattern.test(target))) throw new SafeError('SCOPE_DENIED');
    const targets = source.engine === 'mysql' ? source.access.tables : source.access.collections;
    if (source.access.readScope === 'allowlist' && !targets.includes(target)) throw new SafeError('SCOPE_DENIED');
    const configuredFields = source.engine === 'mysql' ? source.access.columns : source.access.fields;
    const allowedFields = source.access.readScope === 'allowlist' && Object.hasOwn(configuredFields, target) ? configuredFields[target] : undefined;
    const fields = (source.engine === 'mysql' ? args.columns : args.fields) as string[] | undefined;
    const filter = (source.engine === 'mysql' ? args.where : args.filter) as Record<string, unknown> | undefined;
    const orderBy = args.orderBy as ReadPlan['orderBy'];
    const used = [...(fields ?? []), ...Object.keys(filter ?? {}), ...(orderBy ?? []).map(item => item.field)];
    if (used.length > 256 || used.some(f => (allowedFields && !allowedFields.includes(f)) ||
      (source.engine === 'mysql' ? !mysqlIdentifierPattern.test(f) : !mongoFieldPattern.test(f)))) throw new SafeError('SCOPE_DENIED');
    return { ...plan, target, fields: fields ?? allowedFields, filter: filter ?? {}, orderBy,
      limit: tool === 'mongodb_find_one' ? 1 : plan.limit };
  }
  if (tool === 'redis_keys') {
    const prefix = args.prefix === undefined && source.access.readScope === 'database' ? '' : args.prefix;
    if (typeof prefix !== 'string' || (source.access.readScope === 'database' ? prefix !== '' : !source.access.keyPrefixes.includes(prefix))) {
      throw new SafeError('SCOPE_DENIED', { reason: 'scan_prefix_denied', path: '$.prefix' });
    }
    return { ...plan, prefix };
  }
  const key = parseRedisReadKey(args.key);
  if (!key) throw new SafeError('INVALID_ARGUMENT', { reason: 'invalid_value', path: '$.key' });
  if (source.access.readScope === 'allowlist' && !source.access.keyPrefixes.some(prefix => {
    const bytes = Buffer.from(prefix);
    return key.subarray(0, bytes.length).equals(bytes);
  })) throw new SafeError('SCOPE_DENIED');
  return { ...plan, redisKey: key, offset: (args.offset as number | undefined) ?? 0,
    bytes: Math.min((args.bytes as number | undefined) ?? Math.floor(source.budgets.maxItemBytes / 8), Math.floor(source.budgets.maxItemBytes / 8)) };
}
