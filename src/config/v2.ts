import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { SafeError } from '../runtime/errors.js';
import { definitions } from '../runtime/tool-catalog.js';
import { databaseExcluded, databaseKey, mongoDatabasePattern, mysqlDatabasePattern, redisDatabases } from '../runtime/database-scope.js';

const identifier = z.string().regex(/^[A-Za-z0-9_$]+$/).max(128)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/).max(128)
  .refine(value => !value.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)));
const absolutePath = z.string().max(4096).refine(path.isAbsolute);
const secretRef = z.string().max(4096).refine(value =>
  /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value) || (value.startsWith('file:') && path.isAbsolute(value.slice(5))));
const inlineSecret = z.string().min(1).max(65536).refine(value =>
  !value.includes('\0') && Buffer.byteLength(value) <= 65536 && Buffer.from(value).toString('utf8') === value)
  .meta({ writeOnly: true });
const databasePassword = { password: inlineSecret.optional(), passwordRef: secretRef.optional() };
const integer = (max: number, fallback: number, min = 1) => z.number().int().min(min).max(max).default(fallback);
const sshHost = z.string().min(1).max(253).refine(value => isIP(value) !== 0 ||
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value));
const sshPassword = z.object({ method: z.literal('password'), passwordRef: secretRef }).strict();
const localSsh = z.object({
  host: sshHost,
  passwordRef: secretRef.optional(),
}).strict();
const pinnedSsh = z.object({
  host: sshHost,
  port: integer(65535, 22), username: z.string().min(1).max(128).regex(/^[^\x00-\x20\x7f]+$/),
  hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).refine(value =>
    Buffer.from(value.slice(7), 'base64').toString('base64').replace(/=+$/, '') === value.slice(7)),
  auth: z.discriminatedUnion('method', [
    sshPassword,
    z.object({ method: z.literal('private_key'), privateKeyRef: secretRef, passphraseRef: secretRef.optional() }).strict(),
  ]),
}).strict();
const ssh = z.union([localSsh, pinnedSsh]);
const tls = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('verify_identity'), caFile: absolutePath.optional() }).strict(),
  z.object({ mode: z.literal('disabled') }).strict(),
]);
const budgets = z.object({
  maxRows: integer(1000, 200), maxResponseBytes: integer(1024 * 1024, 65536, 1024),
  maxItemBytes: integer(256 * 1024, 16384, 256), maxRequestBytes: integer(256 * 1024, 32768, 1024),
  maxConcurrent: integer(16, 2), maxQueued: integer(100, 20), maxConnections: integer(8, 2),
  connectTimeoutMs: integer(30000, 10000), queueTimeoutMs: integer(10000, 2000),
  queryTimeoutMs: integer(30000, 5000), maxScanPages: integer(1000, 50),
}).strict().prefault({});
const tools = z.array(z.string().max(64)).max(32).optional();
// Account grants never opt the application into writes. Each level must opt in explicitly.
const tier = z.enum(['read_only', 'read_write']).default('read_only');
// Scope inference runs before parsing so the input schema remains useful to editors.
function readAccess<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, readScope: z.enum(['database', 'allowlist']).default('database') }).strict();
}
function normalizeReadScopes(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { sources?: unknown }).sources)) return input;
  const value = input as { sources: unknown[] };
  return { ...value, sources: value.sources.map(source => {
    if (!source || typeof source !== 'object') return source;
    const item = source as { engine?: unknown; access?: unknown };
    if (!item.access || typeof item.access !== 'object' || Array.isArray(item.access)) return source;
    const access = item.access as Record<string, unknown>;
    const rangeFields = item.engine === 'mysql' ? ['tables', 'columns'] : item.engine === 'mongodb' ? ['collections', 'fields'] : ['keyPrefixes'];
    return { ...item, access: { ...access, readScope: access.readScope === undefined ?
      rangeFields.some(field => Object.hasOwn(access, field)) ? 'allowlist' : 'database' : access.readScope } };
  }) };
}
const writeObject = z.object({
  versionColumn: identifier, writableColumns: z.array(identifier).min(1).max(32),
  allowInsert: z.boolean().default(false), allowUpdate: z.boolean().default(false), allowDelete: z.boolean().default(false),
}).strict();
const journal = z.object({ directory: absolutePath, maxOperations: integer(10000, 1000),
  retentionDays: integer(90, 7), previewTtlMs: integer(300000, 60000, 1000), maxPrepared: integer(100, 20) }).strict();
const base = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  required: z.boolean().default(true), purpose: z.string().max(200).default(''),
  tls, budgets, ssh: ssh.optional(), databaseScope: z.enum(['default', 'visible']).optional(),
};
const redisDatabase = z.number().int().min(0).max(15);
const mongoDatabase = z.string().regex(mongoDatabasePattern);
const mysql = z.object({
  ...base, engine: z.literal('mysql'), host: z.string().min(1).max(253), port: integer(65535, 3306),
  database: z.string().regex(mysqlDatabasePattern), username: z.string().min(1).max(128).refine(v => v.toLowerCase() !== 'root'), ...databasePassword,
  excludeDatabases: z.array(z.string().regex(mysqlDatabasePattern)).max(128).optional(),
  access: readAccess({ tier, tables: z.array(identifier).max(128).default([]),
    columns: z.record(z.string(), z.array(identifier).min(1).max(128)).default({}),
    rawSql: z.literal(false).default(false), allowedTools: tools,
    writes: z.object({ metadataGuard: identifier, tables: z.record(z.string(), writeObject.extend({ keyColumns: z.array(identifier).min(1).max(8) })) }).strict().optional() }),
}).strict();
const redis = z.object({
  ...base, engine: z.literal('redis'), host: z.string().min(1).max(253), port: integer(65535, 6379),
  username: z.string().min(1).max(128).default('default'), ...databasePassword,
  database: redisDatabase.default(0), databases: z.array(redisDatabase).max(16).optional(),
  excludeDatabases: z.array(redisDatabase).max(16).optional(),
  access: readAccess({ tier, keyPrefixes: z.array(z.string().min(1).max(128)
    .refine(v => !/[\x00-\x1f*?\[\]\\]/.test(v) && Buffer.from(v).toString('utf8') === v)).max(16).default([]),
    allowKeyspaceScan: z.boolean().default(false), allowedTools: tools,
    writes: z.object({ allowCreate: z.boolean().default(false), allowReplace: z.boolean().default(false),
      allowDelete: z.boolean().default(false), maxTtlSeconds: integer(604800, 86400) }).strict().optional() }),
}).strict();
const mongodb = z.object({
  ...base, engine: z.literal('mongodb'), database: mongoDatabase,
  excludeDatabases: z.array(mongoDatabase).max(128).optional(),
  connectionString: inlineSecret.optional(), connectionStringRef: secretRef.optional(), requireIndexedReads: z.boolean().default(false),
  access: readAccess({ tier, collections: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/).max(128)).max(128).default([]),
    fields: z.record(z.string(), z.array(field).min(1).max(128)).default({}), allowedTools: tools,
    writes: z.object({ collections: z.record(z.string(), writeObject) }).strict().optional() }),
}).strict();
const schema = z.object({
  $schema: z.string().max(4096).optional(), version: z.literal(2),
  instance: z.object({ name: z.string().min(1).max(64), transport: z.literal('stdio'),
    environment: z.enum(['production', 'development', 'test']), tier, journal: journal.optional(),
    budgets: z.object({ maxSources: integer(16, 4), maxConcurrent: integer(32, 4),
      maxQueued: integer(200, 40), maxConnections: integer(32, 8),
      maxRequestBytes: integer(1024 * 1024, 65536, 1024) }).strict().prefault({}),
  }).strict(),
  sources: z.array(z.discriminatedUnion('engine', [mysql, redis, mongodb])).min(1).max(16),
}).strict();

export type V2Config = z.infer<typeof schema>;
export type SourceConfig = V2Config['sources'][number];
export type SshConfig = NonNullable<SourceConfig['ssh']>;
export type PinnedSshConfig = z.infer<typeof pinnedSsh>;
export type ReadBudgets = SourceConfig['budgets'];

export function sourceConnectionLimit(source: SourceConfig): number {
  return source.engine === 'redis' ?
    redisDatabases(source).length + (source.access.tier === 'read_write' ? source.budgets.maxConcurrent : 0) :
    source.budgets.maxConnections + (source.engine === 'mongodb' ? 2 : 0);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export type ConfigDiagnostic = { path: string; reason: string };
export class ConfigValidationError extends SafeError {
  constructor(public readonly diagnostics: readonly ConfigDiagnostic[]) { super('INVALID_CONFIG'); }
}
// Never expose arbitrary object keys, Zod messages, input values, or filesystem errors.
const diagnosticFields = new Set(['$schema', 'version', 'instance', 'name', 'transport', 'environment', 'tier', 'journal',
  'directory', 'maxOperations', 'retentionDays', 'previewTtlMs', 'maxPrepared', 'budgets', 'maxSources', 'maxConcurrent',
  'maxQueued', 'maxConnections', 'maxRows', 'maxResponseBytes', 'maxItemBytes', 'maxRequestBytes', 'connectTimeoutMs',
  'queueTimeoutMs', 'queryTimeoutMs', 'maxScanPages', 'sources', 'id', 'engine', 'required', 'purpose', 'tls', 'mode', 'caFile',
  'ssh', 'host', 'port', 'username', 'hostKeySha256', 'auth', 'method', 'password', 'passwordRef', 'privateKeyRef', 'passphraseRef',
  'database', 'databaseScope', 'databases', 'excludeDatabases', 'connectionString', 'connectionStringRef', 'requireIndexedReads', 'access', 'readScope', 'tables', 'columns', 'collections', 'fields',
  'keyPrefixes', 'allowKeyspaceScan', 'rawSql', 'allowedTools', 'writes', 'metadataGuard', 'versionColumn', 'writableColumns',
  'keyColumns', 'allowInsert', 'allowUpdate', 'allowDelete', 'allowCreate', 'allowReplace', 'maxTtlSeconds']);
function diagnosticPath(parts: PropertyKey[]): string {
  return '$' + parts.map(part => typeof part === 'number' ? '[' + part + ']' : '.' +
    (typeof part === 'string' && diagnosticFields.has(part) ? part : '*')).join('');
}
function invalid(path: string, reason: string): never { throw new ConfigValidationError([{ path, reason }]); }

export function configJsonSchema() {
  return { ...z.toJSONSchema(schema, { io: 'input', override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema === mysql || zodSchema === redis) jsonSchema.oneOf = [{ required: ['password'] }, { required: ['passwordRef'] }];
    if (zodSchema === mongodb) jsonSchema.oneOf = [{ required: ['connectionString'] }, { required: ['connectionStringRef'] }];
  } }), title: 'db-mcp v2 configuration',
    description: 'Editor assistance only. Run db-mcp --check for runtime cross-field policies and credential validation. '
      + 'Omitted readScope is inferred from explicit range fields at runtime; no ranges means database scope.' };
}

export function parseV2Config(input: unknown): V2Config {
  let config: V2Config;
  try { config = schema.parse(normalizeReadScopes(input)); }
  catch (error) {
    if (error instanceof z.ZodError) throw new ConfigValidationError(error.issues.slice(0, 16).map(issue => ({
      path: diagnosticPath(issue.path), reason: issue.code === 'unrecognized_keys' ? 'UNKNOWN_FIELD' :
        issue.code === 'invalid_type' ? 'INVALID_TYPE' : issue.code === 'too_big' ? 'TOO_LARGE' :
        issue.code === 'too_small' ? 'TOO_SMALL' : 'INVALID_VALUE',
    })));
    invalid('$', 'INVALID_VALUE');
  }
  if (config.instance.tier === 'read_write') {
    if (config.instance.environment === 'production') invalid('$.instance.environment', 'PRODUCTION_WRITE_DISABLED');
    if (!config.instance.journal) invalid('$.instance.journal', 'JOURNAL_REQUIRED');
    if (!process.getuid) invalid('$.instance.tier', 'UNSUPPORTED_PLATFORM');
  } else if (config.instance.journal) invalid('$.instance.journal', 'READ_ONLY_JOURNAL');
  const global = config.instance.budgets;
  if (config.sources.length > global.maxSources) invalid('$.sources', 'SOURCE_BUDGET_EXCEEDED');
  const ids = new Set<string>();
  for (const [index, source] of config.sources.entries()) {
    if (ids.has(source.id)) invalid('$.sources[' + index + '].id', 'DUPLICATE_SOURCE_ID');
    ids.add(source.id);
  }
  for (const [index, source] of config.sources.entries()) {
    const location = '$.sources[' + index + ']';
    if (source.databaseScope === 'visible' && source.access.tier !== 'read_only') invalid(location + '.databaseScope', 'DATABASE_SCOPE_READ_ONLY');
    if (databaseExcluded(source, source.database)) invalid(location + '.excludeDatabases', 'DEFAULT_DATABASE_EXCLUDED');
    if (source.excludeDatabases && new Set(source.excludeDatabases.map(databaseKey)).size !== source.excludeDatabases.length) {
      invalid(location + '.excludeDatabases', 'DUPLICATE_DATABASE');
    }
    if (source.engine === 'redis' && source.databases) {
      if (source.databaseScope !== 'visible') invalid(location + '.databases', 'VISIBLE_DATABASE_SCOPE_REQUIRED');
      if (new Set(source.databases).size !== source.databases.length) invalid(location + '.databases', 'DUPLICATE_DATABASE');
    }
    const key = source.engine === 'mongodb' ? 'connectionString' : 'password';
    const credential = source.engine === 'mongodb' ? source.connectionString : source.password;
    const reference = source.engine === 'mongodb' ? source.connectionStringRef : source.passwordRef;
    if (credential !== undefined && reference !== undefined) invalid(location + '.' + key, 'CREDENTIAL_CONFLICT');
    if (credential === undefined && reference === undefined) invalid(location + '.' + key + 'Ref', 'CREDENTIAL_REQUIRED');
    for (const [toolIndex, name] of (source.access.allowedTools ?? []).entries()) {
      const field = location + '.access.allowedTools[' + toolIndex + ']';
      const tool = definitions.find(tool => tool.name === name);
      if (!tool) invalid(field, 'UNKNOWN_TOOL');
      if (tool.name === 'list_databases') {
        if (source.databaseScope !== 'visible') invalid(field, 'VISIBLE_DATABASE_SCOPE_REQUIRED');
        continue;
      }
      if (!tool.engine) invalid(field, 'TOOL_NOT_SOURCE_SCOPED');
      if (tool.engine !== source.engine) invalid(field, 'TOOL_ENGINE_MISMATCH');
    }
    if (source.access.readScope === 'database') {
      if (source.access.tier !== 'read_only' || (source.engine === 'mysql' ? source.access.tables.length || Object.keys(source.access.columns).length :
        source.engine === 'mongodb' ? source.access.collections.length || Object.keys(source.access.fields).length : source.access.keyPrefixes.length)) {
        invalid(location + '.access.readScope', 'DATABASE_SCOPE_CONFLICT');
      }
    } else if (!(source.engine === 'mysql' ? source.access.tables.length : source.engine === 'mongodb' ? source.access.collections.length : source.access.keyPrefixes.length)) {
      invalid(location + '.access.readScope', 'EMPTY_ALLOWLIST');
    }
    if (source.engine === 'redis' && source.username === 'default' && source.access.tier !== 'read_only') invalid(location + '.username', 'NAMED_WRITER_REQUIRED');
    if (source.access.tier === 'read_write') {
      if (config.instance.tier !== 'read_write') invalid(location + '.access.tier', 'INSTANCE_WRITE_REQUIRED');
      if (!source.access.writes) invalid(location + '.access.writes', 'WRITE_POLICY_REQUIRED');
      if (source.engine !== 'redis') {
        const policies = source.engine === 'mysql' ? source.access.writes!.tables : source.access.writes!.collections;
        const objects = source.engine === 'mysql' ? source.access.tables : source.access.collections;
        if (!Object.keys(policies).length || Object.keys(policies).some(t => !objects.includes(t))) invalid(location + '.access.writes', 'WRITE_TARGET_OUTSIDE_SCOPE');
        for (const [object, policy] of Object.entries(policies)) {
          const keys: string[] = 'keyColumns' in policy ? policy.keyColumns as string[] : ['_id'];
          const fields = source.engine === 'mysql' ? source.access.columns[object] : source.access.fields[object];
          if (!fields || [policy.versionColumn, ...keys, ...policy.writableColumns].some(f => !fields.includes(f)) ||
              [policy.versionColumn, ...keys].some(f => ['__proto__','constructor','prototype'].includes(f)) ||
              (source.engine === 'mongodb' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(policy.versionColumn)) ||
              keys.includes(policy.versionColumn) || new Set(keys).size !== keys.length ||
              policy.writableColumns.some(f => keys.includes(f) || f === policy.versionColumn || f.includes('.') || ['__proto__','constructor','prototype'].includes(f) ||
                (source.engine === 'mongodb' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f)))) invalid(location + '.access.writes', 'INVALID_WRITE_FIELDS');
          if (!(policy.allowInsert || policy.allowUpdate || policy.allowDelete)) invalid(location + '.access.writes', 'WRITE_ACTION_REQUIRED');
        }
      } else if (!(source.access.writes!.allowCreate || source.access.writes!.allowReplace || source.access.writes!.allowDelete)) {
        invalid(location + '.access.writes', 'WRITE_ACTION_REQUIRED');
      }
    } else if (source.access.writes) invalid(location + '.access.writes', 'READ_ONLY_WRITE_POLICY');
    for (const budget of ['maxConcurrent', 'maxQueued', 'maxRequestBytes'] as const) {
      if (source.budgets[budget] > global[budget]) invalid(location + '.budgets.' + budget, 'INSTANCE_BUDGET_EXCEEDED');
    }
    if (source.budgets.maxItemBytes > source.budgets.maxResponseBytes) invalid(location + '.budgets.maxItemBytes', 'RESPONSE_BUDGET_EXCEEDED');
    if (source.access.tier === 'read_write' && source.tls.mode === 'disabled' &&
        source.engine !== 'mongodb' && !['127.0.0.1', '::1', 'localhost'].includes(source.host)) {
      invalid(location + '.tls.mode', 'TLS_REQUIRED');
    }
    if (source.engine === 'mysql') {
      // mysql2 does not consistently verify IP SAN before authentication. Fail closed until supported.
      if (source.tls.mode === 'verify_identity' && isIP(source.host)) invalid(location + '.host', 'MYSQL_TLS_DNS_REQUIRED');
      if (new Set(source.access.tables).size !== source.access.tables.length || Object.keys(source.access.columns).some(t => !source.access.tables.includes(t))) {
        invalid(location + '.access.tables', 'INVALID_TABLE_SCOPE');
      }
    } else if (source.engine === 'mongodb') {
      if (new Set(source.access.collections).size !== source.access.collections.length ||
          source.access.collections.some(c => !Object.hasOwn(source.access.fields, c)) ||
          Object.keys(source.access.fields).some(c => !source.access.collections.includes(c))) invalid(location + '.access.collections', 'INVALID_COLLECTION_SCOPE');
    }
  }
  if (config.sources.reduce((total, source) => total + sourceConnectionLimit(source), 0) > global.maxConnections) {
    invalid('$.instance.budgets.maxConnections', 'CONNECTION_BUDGET_EXCEEDED');
  }
  return freeze(config);
}

export async function loadV2Config(filename: string): Promise<V2Config> {
  if (!path.isAbsolute(filename)) invalid('$', 'CONFIG_PATH_ABSOLUTE');
  let content: string;
  let privateFile: boolean;
  try {
    let followedSymlink = false;
    const flags = constants.O_RDONLY | constants.O_NONBLOCK;
    const handle = await open(filename, flags | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      // Keep reference-only profiles behind symlinks working.
      if (error.code !== 'ELOOP') throw error;
      followedSymlink = true;
      return open(filename, flags);
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) invalid('$', 'CONFIG_NOT_REGULAR');
      if (info.size > 1024 * 1024) invalid('$', 'CONFIG_TOO_LARGE');
      privateFile = !followedSymlink && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
      content = await handle.readFile('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    invalid('$', 'CONFIG_UNREADABLE');
  }
  if (Buffer.byteLength(content) > 1024 * 1024) invalid('$', 'CONFIG_TOO_LARGE');
  let input: unknown;
  try { input = JSON.parse(content); } catch { invalid('$', 'INVALID_JSON'); }
  const config = parseV2Config(input);
  if (!privateFile && config.sources.some(source =>
    source.engine === 'mongodb' ? source.connectionString !== undefined : source.password !== undefined)) {
    invalid('$', 'CONFIG_SECRET_FILE_UNSAFE');
  }
  return config;
}
