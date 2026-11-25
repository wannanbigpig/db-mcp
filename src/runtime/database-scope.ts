import type { SourceConfig } from '../config/v2.js';
import { SafeError } from './errors.js';
import { ListRow } from './pagination.js';

const mysqlDatabaseCharacters = '[A-Za-z0-9_$-]{1,128}';
export const mysqlDatabaseDiscoveryPattern = '^' + mysqlDatabaseCharacters + '$';
export const mysqlDatabasePattern = new RegExp('^(?!(?:__proto__|constructor|prototype)$)' + mysqlDatabaseCharacters + '$');
export const mongoDatabasePattern = /^[A-Za-z0-9_-]{1,64}$/;
export type Database = string | number;

export function databaseKey(value: Database): Database {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

export function databaseExcluded(source: SourceConfig, database: Database): boolean {
  const key = databaseKey(database);
  return source.excludeDatabases?.some(value => databaseKey(value) === key) ?? false;
}

export function redisDatabases(source: Extract<SourceConfig, { engine: 'redis' }>): number[] {
  return [...new Set([source.database, ...(source.databaseScope === 'visible' ? source.databases ?? [] : [])])]
    .filter(database => !databaseExcluded(source, database)).sort((a, b) => a - b);
}

export function databaseDenied(): SafeError {
  return new SafeError('SCOPE_DENIED', { reason: 'database_denied', path: '$.database' });
}

export function* databasePage<T extends Database>(databases: readonly T[], offset: number, limit: number): Iterable<ListRow> {
  for (let index = offset; index < Math.min(databases.length, offset + limit + 1); index++) {
    yield new ListRow({ database: databases[index] }, index + 1);
  }
}
