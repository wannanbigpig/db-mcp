import mysql, { type Connection, type ConnectionOptions, type ExecuteValues, type RowDataPacket, type ResultSetHeader } from 'mysql2';
import type { Duplex, Readable } from 'node:stream';
import type { ReadPlan } from '../policy.js';
import { ListRow } from '../pagination.js';
import { databaseDenied, databaseKey, mysqlDatabaseDiscoveryPattern } from '../database-scope.js';
import type { ReadAdapter } from '../sources.js';
import { connectionError, SafeError, type ErrorCode } from '../errors.js';
import type { MysqlWritePlan, WriteAdapter, WriteHooks, WriteOutcome, WritePreview } from '../write-policy.js';
import { abortable, check, digest, quote, versionOf, type EngineSource } from './shared.js';

function closeConnection(connection: Connection, reason?: SafeError): Promise<void> | undefined {
  // mysql2 3.24.5 only ends the writable side in destroy(). Its current stream
  // is the plain or TLS transport, including connections opened through SSH.
  const transport = (connection as Connection & { stream?: Duplex }).stream;
  const closed = transport && !transport.closed ? new Promise<void>(resolve => transport.once('close', resolve)) : undefined;
  transport?.destroy(reason);
  connection.destroy();
  return closed;
}

export class MysqlReadAdapter implements ReadAdapter {
  private readonly connections = new Set<Connection>();
  private closed = false;
  private unavailable?: (code: ErrorCode) => void;
  readonly writer?: WriteAdapter;
  constructor(private readonly source: EngineSource<'mysql'>, private readonly options: ConnectionOptions) {
    if (source.access.tier === 'read_write') this.writer = {
      preview: async (plan, signal) => {
        if (plan.engine !== 'mysql') throw new SafeError('SCOPE_DENIED');
        const connection = await this.open(signal);
        try {
          return await mysqlPreviewTransaction(connection, source, plan, signal);
        } finally { this.connections.delete(connection); }
      },
      write: async (plan, fingerprint, signal, hooks) => {
        if (plan.engine !== 'mysql') throw new SafeError('SCOPE_DENIED');
        const connection = await this.open(signal, { writing: true });
        try { return await mysqlWriteTransaction(connection, source, plan, signal, fingerprint, hooks); }
        finally { this.connections.delete(connection); }
      },
    };
  }

  onUnavailable(callback: (code: ErrorCode) => void): void { this.unavailable = callback; }

  private reportConnectionFailure(error: unknown, signal?: AbortSignal): void {
    if (!this.source.ssh || this.closed || signal?.aborted) return;
    const { code } = connectionError(error, 'mysql');
    const socketLost = error instanceof Error &&
      ('fatal' in error && error.fatal === true || 'code' in error && error.code === 'ER_SERVER_SHUTDOWN');
    if (socketLost || code === 'DATABASE_TLS_INVALID' || code === 'DATABASE_AUTH_FAILED') this.unavailable?.(code);
  }

  private async open(signal?: AbortSignal, { writing = false, database = this.source.database } = {}): Promise<Connection> {
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    if (signal) check(signal);
    // Commit needs affectedRows to mean changed rows, not CLIENT_FOUND_ROWS matches.
    // Read and preview connections retain their normal capability flags.
    const connection = mysql.createConnection({
      ...this.options, database, ...(writing ? { flags: ['-FOUND_ROWS'] } : {}),
    });
    this.connections.add(connection);
    connection.on('error', () => {}); // never forward raw driver errors to stderr
    const abort = () => { void closeConnection(connection, new SafeError('REQUEST_CANCELLED')); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const connecting = new Promise<void>((resolve, reject) => connection.connect(error => error ? reject(error) : resolve()));
      await (signal ? abortable(connecting, signal) : connecting);
      if (signal) check(signal);
      return connection;
    } catch (error) {
      await closeConnection(connection); this.connections.delete(connection);
      if (database !== this.source.database && error instanceof Error && 'code' in error &&
          (error.code === 'ER_DBACCESS_DENIED_ERROR' || error.code === 'ER_BAD_DB_ERROR')) throw databaseDenied();
      this.reportConnectionFailure(error, signal);
      throw error;
    }
    finally { signal?.removeEventListener('abort', abort); }
  }

  async connect(): Promise<void> {
    const connection = await this.open();
    try { await connection.promise().query({ sql: 'SELECT 1', timeout: this.source.budgets.connectTimeoutMs }); }
    finally { await closeConnection(connection); this.connections.delete(connection); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections].map(connection => closeConnection(connection, new SafeError('SOURCE_UNAVAILABLE'))));
    this.connections.clear();
  }

  async *read(plan: ReadPlan, signal: AbortSignal): AsyncIterable<unknown> {
    const database = typeof plan.database === 'string' ? plan.database : this.source.database;
    const connection = await this.open(signal, { database });
    let stream: Readable | undefined;
    const abort = () => {
      const reason = new SafeError('REQUEST_CANCELLED');
      stream?.destroy(reason);
      void closeConnection(connection, reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      check(signal);
      // A read-only transaction supplements, but never replaces, the provisioned read-only account.
      await abortable(connection.promise().query({ sql: 'SET SESSION TRANSACTION READ ONLY', timeout: this.source.budgets.queryTimeoutMs }), signal);
      await abortable(connection.promise().query({ sql: 'START TRANSACTION READ ONLY', timeout: this.source.budgets.queryTimeoutMs }), signal);
      check(signal);
      const params: ExecuteValues[] = [];
      const paginated = plan.tool === 'list_databases' || plan.tool === 'mysql_list_tables' || plan.tool === 'mysql_describe_table';
      const offset = plan.position ?? 0;
      if (typeof offset !== 'number') throw new SafeError('INVALID_ARGUMENT');
      let sql: string;
      if (plan.tool === 'list_databases') {
        const excluded = ['__proto__', 'constructor', 'prototype', ...(this.source.excludeDatabases ?? [])].map(databaseKey);
        // Use binary equality after folding ASCII database names for exclusions.
        // The server applies exclusions before LIMIT/OFFSET so pages cannot reveal them.
        sql = 'SELECT SCHEMA_NAME AS `database` FROM information_schema.SCHEMATA ' +
          'WHERE SCHEMA_NAME REGEXP ? AND CAST(LOWER(SCHEMA_NAME) AS BINARY) NOT IN (' +
          excluded.map(() => '?').join(',') + ') ORDER BY CAST(SCHEMA_NAME AS BINARY)';
        params.push(mysqlDatabaseDiscoveryPattern, ...excluded);
      } else if (plan.tool === 'mysql_list_tables') {
        sql = 'SELECT /*+ MAX_EXECUTION_TIME(' + this.source.budgets.queryTimeoutMs + ') */ TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?';
        params.push(database);
        if (this.source.access.readScope !== 'database') {
          sql += ' AND TABLE_NAME IN (' + this.source.access.tables.map(() => '?').join(',') + ')';
          params.push(...this.source.access.tables);
        }
        // The binary tiebreaker keeps case variants in a repeatable order.
        sql += ' ORDER BY TABLE_NAME, CAST(TABLE_NAME AS BINARY)';
      } else if (plan.tool === 'mysql_describe_table') {
        sql = 'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?';
        params.push(database, plan.target!);
        if (plan.fields) { sql += ' AND COLUMN_NAME IN (' + plan.fields.map(() => '?').join(',') + ')'; params.push(...plan.fields); }
        sql += ' ORDER BY ORDINAL_POSITION';
      } else {
        sql = 'SELECT /*+ MAX_EXECUTION_TIME(' + this.source.budgets.queryTimeoutMs + ') */ ' +
          (plan.fields?.map(quote).join(',') ?? '*') + ' FROM ' + quote(plan.target!);
        const terms = Object.entries(plan.filter ?? {}).map(([key, value]) => {
          if (value === null) return quote(key) + ' IS NULL';
          params.push(value as ExecuteValues); return quote(key) + ' = ?';
        });
        if (terms.length) sql += ' WHERE ' + terms.join(' AND ');
        if (plan.orderBy?.length) sql += ' ORDER BY ' + plan.orderBy.map(o => quote(o.field) + ' ' + o.direction.toUpperCase()).join(',');
        sql += ' LIMIT ' + plan.limit;
      }
      if (paginated) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(plan.limit + 1, offset);
      }
      // Native prepared statement + stream: no string interpolation of values or full-result execute().
      // mysql2's inactivity timer can outlive a destroyed/early-ended stream. The dispatcher owns
      // the total deadline and closes this socket; avoid a second orphan timer on the command.
      // Read arrays with mysql2's static parser so valid column names never
      // pass through its object-field blacklist. Keep the public rows as objects.
      const options = { sql, rowsAsArray: true, disableEval: true };
      const command = connection.execute(options, params);
      let names: string[] = [];
      command.on('fields', (fields: Array<{ name: string }>) => { names = fields.map(field => field.name); });
      command.on('error', () => {}); // stream handles live errors; late teardown errors stay contained
      stream = command.stream({ highWaterMark: 1 });
      let next = offset;
      try {
        for await (const row of stream as AsyncIterable<unknown[]>) {
          check(signal);
          const value = Object.fromEntries(names.map((name, index) => [name, row[index]]));
          yield paginated ? new ListRow(value, ++next) : value;
        }
      }
      finally { stream.destroy(); }
    } catch (error) {
      this.reportConnectionFailure(error, signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      // Early termination must discard the connection; never return an unread result to a pool.
      await closeConnection(connection); this.connections.delete(connection);
    }
  }
}

export async function mysqlPreviewTransaction(connection: Connection, source: EngineSource<'mysql'>,
  plan: MysqlWritePlan, signal: AbortSignal): Promise<WritePreview> {
  const result = await mysqlTransaction(connection, source, plan, signal, { mode: 'preview' });
  if ('fingerprint' in result) return result;
  throw new Error('Unexpected write result for a preview transaction');
}

export async function mysqlWriteTransaction(connection: Connection, source: EngineSource<'mysql'>,
  plan: MysqlWritePlan, signal: AbortSignal, fingerprint: string, hooks: WriteHooks): Promise<WriteOutcome> {
  const result = await mysqlTransaction(connection, source, plan, signal, { mode: 'write', fingerprint, hooks });
  if ('state' in result) return result;
  throw new Error('Unexpected preview result for a write transaction');
}

async function mysqlMetadata(connection: Connection, source: EngineSource<'mysql'>, plan: MysqlWritePlan, signal: AbortSignal) {
  const [result] = await abortable(connection.promise().query('CALL ' + quote(source.access.writes!.metadataGuard) + '(?, ?)', [source.database, plan.target]), signal);
  const sets = result as unknown as Array<RowDataPacket[]>;
  if (!Array.isArray(sets) || sets.length !== 6 || sets.slice(0, 5).some(s => !Array.isArray(s) || s.length > 256)) throw new SafeError('SCHEMA_UNSAFE');
  const [tables, columns, indexes, foreignKeys, triggers] = sets;
  const policy = source.access.writes!.tables[plan.target];
  const primary = indexes.filter(i => i.INDEX_NAME === 'PRIMARY');
  if (tables.length !== 1 || tables[0].ENGINE !== 'InnoDB' || tables[0].TABLE_TYPE !== 'BASE TABLE' || triggers.length ||
      primary.length !== policy.keyColumns.length || primary.some((i, n) => i.COLUMN_NAME !== policy.keyColumns[n] || Number(i.NON_UNIQUE) !== 0 || i.SUB_PART != null || i.EXPRESSION != null)) throw new SafeError('SCHEMA_UNSAFE');
  for (const name of [...policy.keyColumns, policy.versionColumn, ...policy.writableColumns]) {
    const col = columns.find(c => c.COLUMN_NAME === name);
    if (!col || (col.EXTRA && col.EXTRA !== 'DEFAULT_GENERATED') ||
        (policy.keyColumns.includes(name) && col.IS_NULLABLE !== 'NO') ||
        (name === policy.versionColumn && (col.IS_NULLABLE !== 'NO' || !['tinyint','smallint','mediumint','int','bigint'].includes(col.DATA_TYPE)))) throw new SafeError('SCHEMA_UNSAFE');
  }
  for (const name of policy.keyColumns) {
    const col = columns.find(c => c.COLUMN_NAME === name)!;
    const value = plan.key[name];
    if (['tinyint','smallint','mediumint','int','bigint'].includes(col.DATA_TYPE) ? !Number.isSafeInteger(value) :
      ['char','varchar'].includes(col.DATA_TYPE) ? typeof value !== 'string' : true) throw new SafeError('SCHEMA_UNSAFE');
  }
  if (columns.some(c => String(c.EXTRA).toLowerCase().includes('on update')) ||
      foreignKeys.some(f => f.TABLE_SCHEMA === source.database && f.TABLE_NAME === plan.target && [...policy.writableColumns, policy.versionColumn].includes(f.COLUMN_NAME)) ||
      (plan.action === 'update' && foreignKeys.some(f => f.REFERENCED_TABLE_SCHEMA === source.database && f.REFERENCED_TABLE_NAME === plan.target &&
        [...policy.writableColumns, policy.versionColumn].includes(f.REFERENCED_COLUMN_NAME) && ['CASCADE','SET NULL'].includes(f.UPDATE_RULE))) ||
      (plan.action === 'delete' && foreignKeys.some(f => f.REFERENCED_TABLE_SCHEMA === source.database && f.REFERENCED_TABLE_NAME === plan.target && ['CASCADE','SET NULL'].includes(f.DELETE_RULE)))) throw new SafeError('SCHEMA_UNSAFE');
  return { fingerprint: digest(sets.slice(0, 5)), columns };
}

function mysqlStoredValue(column: RowDataPacket): string {
  const field = quote(column.COLUMN_NAME);
  // Compare actual stored values, not incoming parameters. Server-side binary
  // snapshots retain decimal precision and ignore character collation rules.
  if (['enum', 'set'].includes(column.DATA_TYPE)) return 'CAST(CAST(' + field + ' AS UNSIGNED) AS BINARY)';
  if (['float', 'double'].includes(column.DATA_TYPE)) return 'CAST(CAST(' + field + ' AS DOUBLE) AS BINARY)';
  // Native TIMESTAMP -> epoch avoids DST wall-clock strings hiding distinct values.
  if (column.DATA_TYPE === 'timestamp') return 'CAST(UNIX_TIMESTAMP(' + field + ') AS BINARY)';
  if (!['tinyint','smallint','mediumint','int','bigint','decimal','bit','date','time','datetime','year',
    'char','varchar','binary','varbinary','tinytext','text','mediumtext','longtext','tinyblob','blob','mediumblob','longblob','json'].includes(column.DATA_TYPE)) throw new SafeError('SCHEMA_UNSAFE');
  return 'CAST(' + field + ' AS BINARY)';
}

// The transaction acquires a target table metadata/row lock before re-checking the trusted
// administrator-owned guard. DML identity never needs broad TRIGGER/DDL grants for inspection.
async function mysqlTransaction(connection: Connection, source: EngineSource<'mysql'>,
  plan: MysqlWritePlan, signal: AbortSignal, execution: { mode: 'preview' } | { mode: 'write'; fingerprint: string; hooks: WriteHooks }): Promise<WritePreview | WriteOutcome> {
  let sent = false, committing = false;
  const abort = () => { void closeConnection(connection, new SafeError('REQUEST_CANCELLED')); };
  signal.addEventListener('abort', abort, { once: true });
  const execute = (sql: string, values: unknown[] = []) => abortable(connection.promise().execute(sql, values as ExecuteValues[]), signal);
  const control = (sql: string) => abortable(connection.promise().query(sql), signal);
  try {
    check(signal);
    await control("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await control('SET SESSION innodb_lock_wait_timeout = ' + Math.max(1, Math.ceil(source.budgets.queryTimeoutMs / 1000)));
    await control('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await control('START TRANSACTION READ WRITE');
    const entries = Object.entries(plan.key);
    const where = entries.map(([key]) => quote(key) + ' = ?').join(' AND ');
    const fields = Object.entries(plan.values ?? {});
    const [raw] = await execute('SELECT ' + quote(plan.versionColumn) + ' AS current_version FROM ' + quote(plan.target) + ' WHERE ' + where + ' LIMIT 2 FOR UPDATE', entries.map(([, v]) => v));
    const rows = raw as RowDataPacket[];
    const metadata = await mysqlMetadata(connection, source, plan, signal);
    if (rows.length > 1) throw new SafeError('SCHEMA_UNSAFE');
    const current = rows[0] ? versionOf(rows[0].current_version) : undefined;
    const matches = plan.action === 'insert' ? !rows.length : current === plan.expectedVersion;
    if (execution.mode === 'preview') {
      await control('ROLLBACK');
      return { fingerprint: metadata.fingerprint, condition: matches ? 'match' : !rows.length ? 'missing' : 'conflict' };
    }
    if (execution.fingerprint !== metadata.fingerprint) throw new SafeError('SCHEMA_CHANGED');
    if (!matches) throw new SafeError(!rows.length ? 'TARGET_NOT_FOUND' : 'VERSION_CONFLICT');
    const version = quote(plan.versionColumn);
    const atVersionLimit = current === Number.MAX_SAFE_INTEGER;
    let nextVersion = version;
    if (plan.action === 'update') {
      const stored = fields.map(([name]) => mysqlStoredValue(metadata.columns.find(c => c.COLUMN_NAME === name)!));
      const lockedWhere = ' FROM ' + quote(plan.target) + ' WHERE ' + where + ' AND ' + quote(plan.versionColumn) + ' = ?';
      const locating = [...entries.map(([, v]) => v), plan.expectedVersion];
      const [sizes] = await execute('SELECT ' + stored.map(expr => 'COALESCE(OCTET_LENGTH(' + expr + '),0)').join(' + ') + ' AS snapshot_bytes' + lockedWhere, locating);
      const sizeRows = sizes as RowDataPacket[];
      if (sizeRows.length !== 1) throw new SafeError('VERSION_CONFLICT');
      const bytes = Number(sizeRows[0].snapshot_bytes);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > source.budgets.maxItemBytes) throw new SafeError('BUDGET_EXCEEDED');
      // Fixed session variables never leave the database connection. SELECT INTO
      // returns no old content; the row lock prevents a length/capture race, and
      // destroying this dedicated connection frees the bounded snapshots.
      const variables = stored.map((_expr, i) => '@db_mcp_before_' + i);
      await execute('SELECT ' + stored.join(',') + lockedWhere + ' INTO ' + variables.join(','), locating);
      const unchanged = stored.map((expr, i) => '(' + expr + ' <=> ' + variables[i] + ')').join(' AND ');
      if (!atVersionLimit) nextVersion += ' + IF((' + unchanged + '),0,1)';
    }
    check(signal); execution.hooks.sent(); sent = true;
    let result: ResultSetHeader;
    if (plan.action === 'insert') {
      const values = { ...plan.key, ...plan.values, [plan.versionColumn]: 0 };
      [result] = await execute('INSERT INTO ' + quote(plan.target) + ' (' + Object.keys(values).map(quote).join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values)) as [ResultSetHeader, unknown];
    } else if (plan.action === 'update') {
      // MySQL SINGLE-table UPDATE evaluates assignments left-to-right. Version is
      // last and observes the already assigned/converted fields, so native CHECKs
      // see one atomic final row, and actual no-change never advances the version.
      // At the JS ceiling, leave the version as-is and use the true changed-row
      // count to distinguish a valid no-op from a change that must be rolled back.
      [result] = await execute('UPDATE ' + quote(plan.target) + ' SET ' + fields.map(([f]) => quote(f) + ' = ?').join(',') + ', ' + version + ' = ' + nextVersion + ' WHERE ' + where + ' AND ' + version + ' = ?',
        [...fields.map(([, v]) => v), ...entries.map(([, v]) => v), plan.expectedVersion]) as [ResultSetHeader, unknown];
      if (result.affectedRows === 0) {
        await control('ROLLBACK'); return { state: 'success', directAffected: 0, effect: 'no_change', version: current };
      }
      if (result.affectedRows !== 1) throw new SafeError('VERSION_CONFLICT');
      if (atVersionLimit) throw new SafeError('VERSION_LIMIT_REACHED');
      const [after] = await execute('SELECT ' + quote(plan.versionColumn) + ' AS current_version FROM ' + quote(plan.target) + ' WHERE ' + where + ' LIMIT 2', entries.map(([, v]) => v));
      const afterRows = after as RowDataPacket[];
      if (afterRows.length !== 1 || !Number.isSafeInteger(Number(afterRows[0].current_version)) || Number(afterRows[0].current_version) !== plan.expectedVersion + 1) throw new SafeError('SCHEMA_UNSAFE');
    } else {
      [result] = await execute('DELETE FROM ' + quote(plan.target) + ' WHERE ' + where + ' AND ' + quote(plan.versionColumn) + ' = ?', [...entries.map(([, v]) => v), plan.expectedVersion]) as [ResultSetHeader, unknown];
    }
    if (result.affectedRows !== 1) throw new SafeError('VERSION_CONFLICT');
    check(signal); committing = true; await control('COMMIT');
    return { state: 'success', directAffected: 1, effect: plan.action === 'insert' ? 'inserted' : plan.action === 'update' ? 'updated' : 'deleted',
      ...(plan.action !== 'delete' ? { version: plan.action === 'insert' ? 0 : plan.expectedVersion + 1 } : {}) };
  } catch (error) {
    let rolledBack = false;
    if (!committing && !signal.aborted) { try { await control('ROLLBACK'); rolledBack = true; } catch { /* no acknowledgement, remain unknown */ } }
    if (execution.mode === 'preview') {
      if (error instanceof SafeError) throw error;
      // mysql2 marks a lost connection fatal, including when an SSH forward
      // closes mid-query. Server SQL errors still fail schema inspection closed.
      const unavailable = error instanceof Error && 'fatal' in error && error.fatal === true;
      throw new SafeError(unavailable ? 'SOURCE_UNAVAILABLE' : 'SCHEMA_UNSAFE');
    }
    // Never treat a lost COMMIT acknowledgement as a rollback: ROLLBACK after it may be a no-op.
    if (committing || (sent && !rolledBack)) return { state: 'unknown_outcome', code: 'WRITE_OUTCOME_UNKNOWN' };
    return { state: sent ? 'failed' : 'not_started', code: error instanceof SafeError ? error.code : sent ? 'WRITE_REJECTED' : 'SOURCE_UNAVAILABLE' };
  } finally { signal.removeEventListener('abort', abort); await closeConnection(connection); }
}
