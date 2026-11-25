import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { BSON, MongoClient, MongoServerError, ObjectId, type Document, type ServerHeartbeatFailedEvent } from 'mongodb';
import ConnectionString from 'mongodb-connection-string-url';
import type { V2Config } from '../../config/v2.js';
import type { ReadPlan } from '../policy.js';
import { ListRow } from '../pagination.js';
import { databaseDenied, databaseExcluded, databasePage, mongoDatabasePattern } from '../database-scope.js';
import type { ReadAdapter } from '../sources.js';
import { connectionError, SafeError, safeError, type ErrorCode } from '../errors.js';
import { raceWithAbort } from '../../utils/async.js';
import type { MongoWritePlan, WriteAdapter, WriteHooks, WriteOutcome, WritePreview } from '../write-policy.js';
import type { TunnelEndpoint, TunnelTarget } from '../ssh-tunnel.js';
import { check, digest, type EngineSource } from './shared.js';

const disabledDriverLog = { default: 'off', command: 'off', topology: 'off', serverSelection: 'off', connection: 'off', client: 'off' } as const;

function mongoTcpTarget(uri: string): TunnelTarget {
  // The constructor parses URI options and HostAddress without opening a socket.
  // Use the driver's address instead of an HTTP URL, which would swallow port 80.
  const [address] = new MongoClient(uri, { mongodbLogComponentSeverities: disabledDriverLog }).options.hosts;
  if (!address?.host || !address.port) throw new Error('TCP target required');
  return { host: address.host, port: address.port };
}

// Reject URI overrides instead of silently merging contradictory TLS, database or retry settings.
export function validateMongoTarget(uri: string, source: EngineSource<'mongodb'>, config: V2Config): TunnelTarget {
  try {
    const parsed = new ConnectionString(uri);
    if (!parsed.username || !parsed.password || parsed.hash || parsed.isSRV || parsed.hosts.length !== 1 || decodeURIComponent(parsed.pathname.slice(1)) !== source.database) throw new Error();
    const seen = new Set<string>();
    for (const [key] of parsed.searchParams) {
      if (!['authSource', 'replicaSet', 'directConnection'].includes(key) || seen.has(key)) throw new Error();
      seen.add(key);
    }
    if (parsed.searchParams.has('directConnection') && parsed.searchParams.get('directConnection') !== 'true') throw new Error();
    const target = mongoTcpTarget(uri);
    if (source.access.tier === 'read_write' && source.tls.mode === 'disabled' && (config.instance.environment === 'production' ||
        !['127.0.0.1', '::1', 'localhost'].includes(target.host))) throw new Error();
    return target;
  } catch { throw new SafeError('INVALID_CONFIG'); }
}

export function validateMongoURI(uri: string, source: EngineSource<'mongodb'>, config: V2Config): string {
  validateMongoTarget(uri, source, config);
  return uri;
}

// Inspect only the selected plan: rejected alternatives and filter field names
// are not execution stages. Unknown planner shapes fail closed when opted in.
function usesKnownIndexPlan(explanation: Document): boolean {
  const indexedLeaves = new Set(['IXSCAN', 'IDHACK', 'DISTINCT_SCAN', 'COUNT_SCAN', 'EXPRESS_IXSCAN', 'EXPRESS_CLUSTERED_IXSCAN']);
  const wrappers = new Set(['FETCH', 'LIMIT', 'SKIP', 'SORT', 'SORT_SIMPLE', 'SORT_DEFAULT', 'SORT_KEY_GENERATOR',
    'SORT_MERGE', 'PROJECTION', 'PROJECTION_SIMPLE', 'PROJECTION_DEFAULT', 'PROJECTION_COVERED', 'OR', 'AND_HASH', 'AND_SORTED', 'SHARDING_FILTER']);
  let visited = 0;
  const inspect = (value: unknown, depth: number): boolean => {
    if (++visited > 256 || depth > 32 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const node = value as Record<string, unknown>;
    if (node.queryPlan) return inspect(node.queryPlan, depth + 1); // MongoDB's SBE planner envelope
    if (typeof node.stage !== 'string' || node.stage === 'COLLSCAN') return false;
    if (indexedLeaves.has(node.stage)) return true;
    if (!wrappers.has(node.stage)) return false;
    const children = [...(node.inputStage ? [node.inputStage] : []), ...(Array.isArray(node.inputStages) ? node.inputStages : [])];
    return children.length > 0 && children.every(child => inspect(child, depth + 1));
  };
  return inspect(explanation.queryPlanner?.winningPlan, 0);
}

function prepareBsonForEjson(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) {
    // The driver has already converted the original int64 to a JavaScript Date.
    if (Number.isNaN(value.getTime())) throw new SafeError('BSON_DATE_OUT_OF_RANGE');
  } else if (value instanceof BSON.Code) {
    prepareBsonForEjson(value.scope);
  } else if (value instanceof BSON.DBRef) {
    prepareBsonForEjson(value.oid);
    prepareBsonForEjson(value.fields);
  } else if (!(value instanceof BSON.BSONValue)) {
    // The driver decodes legacy BSON Undefined to undefined. Preserve its tag
    // before the EJSON encoder would otherwise serialize it as null.
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) (value as Record<string, unknown>)[key] = { $undefined: true };
      else prepareBsonForEjson(child);
    }
  }
}

export class MongoReadAdapter implements ReadAdapter {
  private readonly client: MongoClient;
  private unavailable?: (code: ErrorCode) => void;
  private readonly reportHeartbeatFailure = (event: ServerHeartbeatFailedEvent) => {
    this.unavailable?.(connectionError(event.failure, 'mongodb').code);
  };
  readonly writer?: WriteAdapter;
  constructor(private readonly source: EngineSource<'mongodb'>, uri: string, ca?: Buffer, tunnel?: { endpoint: TunnelEndpoint; target: TunnelTarget }) {
    let dialUri = uri;
    if (tunnel) {
      const parsed = new ConnectionString(uri);
      parsed.hosts = [tunnel.endpoint.host + ':' + tunnel.endpoint.port];
      dialUri = parsed.toString();
    }
    const hostname = tunnel?.target.host;
    this.client = new MongoClient(dialUri, { directConnection: true, tls: source.tls.mode === 'verify_identity',
      ...(ca ? { ca } : {}), tlsAllowInvalidCertificates: false,
      // Node normally verifies the URI host. A loopback transport must verify the
      // original database identity instead, including IP SANs when configured.
      ...(hostname ? { ...(!isIP(hostname) ? { servername: hostname } : {}),
        checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate) } : { tlsAllowInvalidHostnames: false }),
      retryReads: false, retryWrites: false, minPoolSize: 0, maxPoolSize: source.budgets.maxConnections,
      mongodbLogComponentSeverities: disabledDriverLog,
      maxConnecting: 1, connectTimeoutMS: source.budgets.connectTimeoutMs, serverSelectionTimeoutMS: source.budgets.connectTimeoutMs,
      waitQueueTimeoutMS: source.budgets.queueTimeoutMs, socketTimeoutMS: source.budgets.queryTimeoutMs,
      maxIdleTimeMS: 30000,
    });
    if (source.access.tier === 'read_write') this.writer = {
      preview: async (plan, signal) => {
        if (plan.engine !== 'mongodb') throw new SafeError('SCOPE_DENIED');
        return mongoPreview(this.client, source, plan, signal);
      },
      write: async (plan, fingerprint, signal, hooks) => {
        if (plan.engine !== 'mongodb') throw new SafeError('SCOPE_DENIED');
        return mongoWrite(this.client, source, plan, fingerprint, signal, hooks);
      },
    };
  }
  onUnavailable(callback: (code: ErrorCode) => void): void { this.unavailable = callback; }

  async connect(): Promise<void> {
    const tlsFailure = new AbortController();
    const onHeartbeatFailed = (event: ServerHeartbeatFailedEvent) => {
      // The driver reports a certificate failure here before server selection
      // expires. Surface it within the source's total connection deadline.
      if (connectionError(event.failure, 'mongodb').code === 'DATABASE_TLS_INVALID') tlsFailure.abort(event.failure);
    };
    this.client.on('serverHeartbeatFailed', onHeartbeatFailed);
    try {
      await raceWithAbort(this.client.connect(), tlsFailure.signal);
    } catch (error) {
      if (tlsFailure.signal.aborted) await this.client.close().catch(() => {});
      throw error;
    } finally {
      this.client.off('serverHeartbeatFailed', onHeartbeatFailed);
    }
    await this.client.db(this.source.database).command({ ping: 1 });
    if (this.writer) {
      const hello = await this.client.db('admin').command({ hello: 1 });
      if (!hello.setName || !hello.isWritablePrimary || hello.msg === 'isdbgrid') throw new SafeError('SCHEMA_UNSAFE');
    }
    if (this.source.ssh) this.client.on('serverHeartbeatFailed', this.reportHeartbeatFailure);
  }
  async close(): Promise<void> {
    this.client.off('serverHeartbeatFailed', this.reportHeartbeatFailure);
    await this.client.close();
  }

  private async databaseNames(signal: AbortSignal, name?: string): Promise<string[]> {
    const result = await this.client.db('admin').command({
      listDatabases: 1, authorizedDatabases: true, nameOnly: true,
      filter: { name: name ?? { $regex: mongoDatabasePattern.source } },
      maxTimeMS: this.source.budgets.queryTimeoutMs,
    }, { signal });
    return (result.databases as Array<{ name: string }>).map(item => item.name)
      .filter(database => mongoDatabasePattern.test(database) && !databaseExcluded(this.source, database)).sort();
  }

  async *read(plan: ReadPlan, signal: AbortSignal): AsyncIterable<unknown> {
    check(signal);
    if (plan.tool === 'list_databases') {
      const offset = plan.position ?? 0;
      if (typeof offset !== 'number') throw new SafeError('INVALID_ARGUMENT');
      const names = await this.databaseNames(signal);
      check(signal);
      yield* databasePage(names, offset, plan.limit);
      return;
    }
    const database = typeof plan.database === 'string' ? plan.database : this.source.database;
    if (database !== this.source.database && !(await this.databaseNames(signal, database)).includes(database)) throw databaseDenied();
    check(signal);
    if (plan.tool === 'mongodb_list_collections') {
      const offset = plan.position ?? 0;
      if (typeof offset !== 'number') throw new SafeError('INVALID_ARGUMENT');
      const end = offset + plan.limit + 1;
      if (this.source.access.readScope !== 'database') {
        const names = this.source.access.collections;
        for (let index = offset; index < Math.min(end, names.length); index++) {
          check(signal);
          yield new ListRow({ name: names[index] }, index + 1);
        }
        return;
      }
      const cursor = this.client.db(database).listCollections({}, {
        nameOnly: true, authorizedCollections: true, batchSize: Math.min(64, end),
        maxTimeMS: this.source.budgets.queryTimeoutMs, signal,
      });
      try {
        for (let index = 0; index < end; index++) {
          check(signal);
          const item = await cursor.next();
          check(signal);
          if (!item) break;
          if (index >= offset) yield new ListRow({ name: item.name }, index + 1);
        }
      } finally { await cursor.close().catch(() => {}); }
      return;
    }
    const filter: Document = {};
    for (const [field, value] of Object.entries(plan.filter ?? {})) {
      filter[field] = value && typeof value === 'object' ? new ObjectId((value as { $oid: string }).$oid) : value;
    }
    // An explicitly selected parent already includes its children. Remove only
    // redundant child paths; never synthesize a parent from child-only access.
    let projection: Document | undefined;
    if (plan.fields) {
      const fields = plan.fields.filter(field => !plan.fields!.some(parent => field !== parent && field.startsWith(parent + '.')));
      projection = Object.fromEntries(fields.map(field => [field, 1]));
      if (!fields.some(field => field === '_id' || field.startsWith('_id.'))) projection._id = 0;
    }
    const cursor = this.client.db(database).collection(plan.target!).find(filter, {
      ...(projection ? { projection } : {}), promoteValues: false, bsonRegExp: true, limit: plan.limit, batchSize: 1, maxTimeMS: this.source.budgets.queryTimeoutMs, signal,
      ...(plan.orderBy?.length ? { sort: Object.fromEntries(plan.orderBy.map(o => [o.field, o.direction === 'asc' ? 1 : -1])) } : {}),
    });
    try {
      if (this.source.requireIndexedReads) {
        // explain inherits the exact filter, projection, sort, limit and deadline
        // options from this cursor. It does not lock a plan against future DDL.
        const explanation = await cursor.explain('queryPlanner');
        check(signal);
        if (!usesKnownIndexPlan(explanation)) throw new SafeError('QUERY_REQUIRES_INDEX');
      }
      for await (const item of cursor) {
        check(signal);
        // Convert before the dispatcher applies item/response byte budgets.
        prepareBsonForEjson(item);
        yield BSON.EJSON.serialize(item, { relaxed: false });
      }
    }
    finally { await cursor.close().catch(() => {}); }
  }
}

const mongoKey = (value: unknown) => value && typeof value === 'object' ? new ObjectId((value as { $oid: string }).$oid) : value;

function mongoVersionOf(value: unknown): number {
  // Decode BSON Long as bigint so we can check the exact value before converting it.
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SafeError('SCHEMA_UNSAFE');
  return value;
}

async function mongoMetadata(client: MongoClient, source: EngineSource<'mongodb'>, target: string, signal: AbortSignal) {
  const db = client.db(source.database);
  const collections = await db.listCollections({ name: target }, { nameOnly: false, maxTimeMS: source.budgets.queryTimeoutMs, signal }).toArray();
  if (collections.length !== 1 || collections[0].type !== 'collection' || !collections[0].info?.uuid || collections[0].options?.clusteredIndex || collections[0].options?.timeseries) throw new SafeError('SCHEMA_UNSAFE');
  const indexes: Document[] = [];
  const cursor = db.collection(target).listIndexes({ batchSize: 16, maxTimeMS: source.budgets.queryTimeoutMs });
  try { for await (const index of cursor) { check(signal); indexes.push(index); if (indexes.length > 128) throw new SafeError('SCHEMA_UNSAFE'); } }
  finally { await cursor.close().catch(() => {}); }
  if (!indexes.some(i => i.name === '_id_' && Object.keys(i.key).length === 1 && i.key._id === 1 && !i.partialFilterExpression && !i.sparse && (!i.collation || i.collation.locale === 'simple'))) throw new SafeError('SCHEMA_UNSAFE');
  return digest({ collection: collections[0], indexes });
}

export async function mongoPreview(client: MongoClient, source: EngineSource<'mongodb'>, plan: MongoWritePlan, signal: AbortSignal): Promise<WritePreview> {
  const fingerprint = await mongoMetadata(client, source, plan.target, signal);
  const row = await client.db(source.database).collection(plan.target).findOne({ _id: mongoKey(plan.key._id) } as Document,
    { projection: { [plan.versionColumn]: 1 }, useBigInt64: true, maxTimeMS: source.budgets.queryTimeoutMs, signal, collation: { locale: 'simple' } });
  return { fingerprint, condition: plan.action === 'insert' ? row ? 'conflict' : 'match' : !row ? 'missing' : mongoVersionOf(row[plan.versionColumn]) === plan.expectedVersion ? 'match' : 'conflict' };
}

export async function mongoWrite(client: MongoClient, source: EngineSource<'mongodb'>, plan: MongoWritePlan,
  fingerprint: string, signal: AbortSignal, hooks: WriteHooks): Promise<WriteOutcome> {
  const session = client.startSession(); let sent = false, committing = false;
  const db = client.db(source.database), collection = db.collection(plan.target);
  try {
    check(signal); session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: source.budgets.queryTimeoutMs }, maxCommitTimeMS: source.budgets.queryTimeoutMs });
    const id = mongoKey(plan.key._id);
    // Start the snapshot on the target before metadata verification. Drop/recreate cannot
    // transparently switch this transaction to a new collection generation.
    const row = await collection.findOne({ _id: id } as Document, { session, signal, maxTimeMS: source.budgets.queryTimeoutMs,
      projection: { [plan.versionColumn]: 1 }, useBigInt64: true, collation: { locale: 'simple' } });
    if (await mongoMetadata(client, source, plan.target, signal) !== fingerprint) throw new SafeError('SCHEMA_CHANGED');
    if (plan.action !== 'insert' && !row) throw new SafeError('TARGET_NOT_FOUND');
    if (plan.action === 'insert' ? !!row : mongoVersionOf(row![plan.versionColumn]) !== plan.expectedVersion) throw new SafeError('VERSION_CONFLICT');
    const unchanged = plan.action === 'update' && await collection.findOne({ _id: id, [plan.versionColumn]: plan.expectedVersion,
      $expr: { $and: Object.entries(plan.values).map(([k, v]) => ({ $eq: ['$' + k, { $literal: v }] })) } } as Document,
      { session, signal, maxTimeMS: source.budgets.queryTimeoutMs, projection: { _id: 1 }, collation: { locale: 'simple' } });
    if (unchanged) {
      await db.admin().command({ abortTransaction: 1 }, { session, signal });
      return { state: 'success', directAffected: 0, effect: 'no_change', version: plan.expectedVersion };
    }
    if (plan.action === 'update' && plan.expectedVersion === Number.MAX_SAFE_INTEGER) throw new SafeError('VERSION_LIMIT_REACHED');
    check(signal); hooks.sent(); sent = true;
    const options = { session, signal, maxTimeMS: source.budgets.queryTimeoutMs, collation: { locale: 'simple' } };
    if (plan.action === 'insert') {
      await collection.insertOne({ _id: id, ...plan.values, [plan.versionColumn]: 0 } as Document, { session });
    } else {
      const filter = { _id: id, [plan.versionColumn]: plan.expectedVersion } as Document;
      const count = plan.action === 'update' ? (await collection.updateOne(filter, { $set: plan.values, $inc: { [plan.versionColumn]: 1 } }, { ...options, upsert: false })).matchedCount :
        (await collection.deleteOne(filter, options)).deletedCount;
      if (count !== 1) throw new SafeError('VERSION_CONFLICT');
    }
    check(signal); committing = true;
    // The official driver may retry this SAME transaction commit once. This is not
    // re-running DML/withTransaction; uncertain final acknowledgement stays unknown.
    await session.commitTransaction({ timeoutMS: source.budgets.queryTimeoutMs });
    return { state: 'success', directAffected: 1, effect: plan.action === 'insert' ? 'inserted' : plan.action === 'update' ? 'updated' : 'deleted',
      ...(plan.action !== 'delete' ? { version: plan.action === 'insert' ? 0 : plan.expectedVersion + 1 } : {}) };
  } catch (error) {
    // Duplicate-key errors abort the server transaction. The session cleanup
    // may receive NoSuchTransaction, but this DML never reached COMMIT.
    if (sent && !committing && error instanceof MongoServerError && error.code === 11000) {
      return { state: 'failed', code: 'WRITE_REJECTED', directAffected: 0 };
    }
    let rolledBack = false;
    if (!committing && !signal.aborted) { try { await db.admin().command({ abortTransaction: 1 }, { session, signal }); rolledBack = true; } catch { /* ambiguous */ } }
    return { state: committing || (sent && !rolledBack) ? 'unknown_outcome' : sent ? 'failed' : 'not_started',
      code: committing || (sent && !rolledBack) ? 'WRITE_OUTCOME_UNKNOWN' : sent && rolledBack && !(error instanceof SafeError) ? 'WRITE_REJECTED' : safeError(error).code };
  } finally {
    // endSession can issue another bounded abort after an explicit abort command;
    // it never resends DML. A confirmed commit already transitioned the session.
    await session.endSession().catch(() => {});
  }
}
