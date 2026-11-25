import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { createClient, commandOptions, ErrorReply, type RedisClientOptions } from 'redis';
import type { ReadPlan } from '../policy.js';
import type { ReadAdapter } from '../sources.js';
import { SafeError, type ErrorCode } from '../errors.js';
import { ListProgress, ListRow, type ListPosition } from '../pagination.js';
import { databaseDenied, databasePage, redisDatabases } from '../database-scope.js';
import { formatRedisReadKey, maxRedisReadKeyBytes } from '../redis-key.js';
import type { RedisWritePlan, WriteAdapter, WriteOutcome } from '../write-policy.js';
import type { TunnelEndpoint } from '../ssh-tunnel.js';
import { abortable, check, type EngineSource } from './shared.js';

export class RedisReadAdapter implements ReadAdapter {
  private readonly client;
  private readonly databaseClients = new Map<number, { client: ReturnType<typeof createClient>; ready: Promise<ReturnType<typeof createClient>> }>();
  private readonly writingClients = new Set<ReturnType<typeof createClient>>();
  private closed = false;
  private connectionLost = false;
  private unavailable?: (code: ErrorCode) => void;
  readonly writer?: WriteAdapter;
  constructor(private readonly source: EngineSource<'redis'>, password: string, ca?: Buffer, endpoint?: TunnelEndpoint) {
    const options: RedisClientOptions = { username: source.access.tier === 'read_only' && source.username === 'default' ? undefined : source.username, password, database: source.database,
      disableOfflineQueue: true, disableClientInfo: true,
      // AUTH + optional SELECT share the driver's initialization queue; reserve both without widening ACL.
      commandsQueueMaxLength: Math.max(2, source.budgets.maxConcurrent),
      socket: { host: endpoint?.host ?? source.host, port: endpoint?.port ?? source.port, connectTimeout: source.budgets.connectTimeoutMs, reconnectStrategy: false,
        ...(source.tls.mode === 'verify_identity' ? { tls: true, ca, rejectUnauthorized: true,
          ...(!isIP(source.host) ? { servername: source.host } : {}),
          checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(source.host, certificate),
          minVersion: 'TLSv1.2' as const } : {}) },
    };
    this.client = createClient(options);
    const notifyClosed = () => {
      // node-redis reports the socket error again with isOpen=false once it
      // decides not to reconnect. Command error replies never close the client.
      if (this.closed || this.client.isOpen || this.connectionLost) return;
      this.connectionLost = true;
      this.unavailable?.('SOURCE_UNAVAILABLE');
    };
    this.client.on('error', notifyClosed).on('end', notifyClosed);
    if (source.access.tier === 'read_write') this.writer = {
      preview: async (plan, signal) => {
        if (plan.engine !== 'redis') throw new SafeError('SCOPE_DENIED');
        check(signal);
        const type = await this.sharedCommand(() => this.client.type(plan.target));
        check(signal);
        if (type !== 'none' && type !== 'string') throw new SafeError('VERSION_CONFLICT');
        let matches = plan.action === 'create' && type === 'none';
        if (plan.action !== 'create' && type === 'string') {
          const length = await this.sharedCommand(() => this.client.strLen(plan.target));
          check(signal);
          if (length > Math.min(4096, source.budgets.maxItemBytes)) throw new SafeError('BUDGET_EXCEEDED');
          // STRLEN and retrieval can race with another writer. Keep the retrieval itself
          // bounded too, and compare raw bytes rather than lossy UTF-8 decoding.
          const value = Buffer.from(await this.sharedCommand(() => this.client.getRange(commandOptions({ returnBuffers: true }),
            plan.target, 0, Math.min(4096, source.budgets.maxItemBytes))));
          check(signal);
          if (value.length > Math.min(4096, source.budgets.maxItemBytes)) throw new SafeError('BUDGET_EXCEEDED');
          const ttl = await this.sharedCommand(() => this.client.pTTL(plan.target));
          check(signal);
          matches = value.equals(Buffer.from(plan.expectedValue)) && (plan.expectedTtl.mode === 'persistent' ? ttl === -1 : ttl >= plan.expectedTtl.minMs && ttl <= plan.expectedTtl.maxMs);
        }
        check(signal);
        return { fingerprint: 'redis-string-cas-v1', condition: matches ? 'match' : type === 'none' ? 'missing' : 'conflict' };
      },
      write: async (plan, _fingerprint, signal, hooks) => {
        if (plan.engine !== 'redis') throw new SafeError('SCOPE_DENIED');
        if (this.closed) throw new SafeError('SERVER_CLOSED');
        check(signal);
        // Dedicated socket: no other caller's queued command, no reconnect or offline replay.
        const client = createClient(options); this.writingClients.add(client); client.on('error', () => {});
        let sent = false;
        const abort = () => { if (client.isOpen) void client.disconnect().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await abortable(client.connect(), signal); check(signal);
          hooks.sent(); sent = true;
          const reply = await abortable(client.sendCommand(redisWriteArguments(plan, Math.min(4096, source.budgets.maxItemBytes))), signal) as string[];
          if (!Array.isArray(reply) || reply.length !== 1) return { state: 'unknown_outcome', code: 'WRITE_OUTCOME_UNKNOWN' };
          if (reply[0] === 'conflict') return { state: 'failed', code: 'VERSION_CONFLICT', directAffected: 0 };
          if (reply[0] === 'missing') return { state: 'failed', code: 'TARGET_NOT_FOUND', directAffected: 0 };
          if (!['inserted','updated','deleted','no_change'].includes(reply[0])) return { state: 'unknown_outcome', code: 'WRITE_OUTCOME_UNKNOWN' };
          return { state: 'success', directAffected: reply[0] === 'no_change' ? 0 : 1, effect: reply[0] as WriteOutcome['effect'] };
        } catch (error) {
          // Redis checks ACLs before EVAL or the denied Redis command runs.
          // This fixed script has at most one mutating command and no commands after it.
          if (sent && error instanceof ErrorReply &&
              /^(?:NOPERM(?: |$)|ERR (?:ACL failure in script: |The user executing the script can't run this command or subcommand\b))/.test(error.message)) {
            return { state: 'failed', code: 'WRITE_REJECTED', directAffected: 0 };
          }
          return { state: sent ? 'unknown_outcome' : 'not_started',
            code: sent ? 'WRITE_OUTCOME_UNKNOWN' : error instanceof SafeError ? error.code : 'SOURCE_UNAVAILABLE' };
        }
        finally { signal.removeEventListener('abort', abort); if (client.isOpen) await client.disconnect().catch(() => {}); this.writingClients.delete(client); }
      },
    };
  }
  onUnavailable(callback: (code: ErrorCode) => void): void { this.unavailable = callback; }
  async connect(): Promise<void> {
    await this.client.connect(); await this.client.ping();
    if (this.writer) {
      const info = await this.client.info('server');
      if (Number(/redis_version:(\d+)\./.exec(info)?.[1] ?? 0) < 7) throw new SafeError('SCHEMA_UNSAFE');
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const clients = [this.client, ...this.writingClients, ...[...this.databaseClients.values()].map(entry => entry.client)];
    await Promise.all(clients.map(async client => { if (client.isOpen) await client.disconnect().catch(() => {}); }));
    this.databaseClients.clear();
  }

  private async sharedCommand<T>(command: () => Promise<T>, client = this.client): Promise<T> {
    // node-redis 4 retains abort listeners on completed commands. Cancelled callers
    // stop at the application boundary, while the driver command has its own deadline
    // so a missing reply cannot hold read capacity forever. Disconnect flushes the
    // driver queue before releasing these promises and emitting the end event.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      if (client.isOpen) void client.disconnect().catch(() => {});
    }, this.source.budgets.queryTimeoutMs);
    try { return await command(); }
    catch (error) {
      if (timedOut) throw new SafeError('REQUEST_CANCELLED');
      throw error;
    } finally { clearTimeout(deadline); }
  }

  private clientForDatabase(database: number): Promise<ReturnType<typeof createClient>> {
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    if (database === this.source.database) return Promise.resolve(this.client);
    const current = this.databaseClients.get(database);
    if (current?.client.isOpen) return current.ready;

    // SELECT changes the session, so each alternate database owns its socket.
    // A failure on this socket must not retire the default database.
    const client = this.client.duplicate({ database });
    const discard = () => {
      if (this.databaseClients.get(database)?.client === client) this.databaseClients.delete(database);
    };
    client.on('error', () => { if (!client.isOpen) discard(); }).on('end', discard);
    const ready = this.sharedCommand(() => client.connect(), client).then(() => client, async error => {
      if (client.isOpen) await client.disconnect().catch(() => {});
      discard();
      if (error instanceof ErrorReply && /^(?:NOPERM\b|ERR .*(?:DB index|invalid database|SELECT.*not allowed))/i.test(error.message)) {
        throw databaseDenied();
      }
      throw error;
    });
    this.databaseClients.set(database, { client, ready });
    return ready;
  }

  async *read(plan: ReadPlan, signal: AbortSignal): AsyncIterable<unknown> {
    check(signal);
    if (plan.tool === 'list_databases') {
      const offset = plan.position ?? 0;
      if (typeof offset !== 'number') throw new SafeError('INVALID_ARGUMENT');
      const valid: number[] = [];
      for (const database of redisDatabases(this.source)) {
        try { await this.clientForDatabase(database); }
        catch (error) { if (!(error instanceof SafeError) || error.code !== 'SCOPE_DENIED') throw error; continue; }
        check(signal);
        valid.push(database);
        if (valid.length >= offset + plan.limit + 1) break;
      }
      yield* databasePage(valid, offset, plan.limit);
      return;
    }
    const client = await this.clientForDatabase(typeof plan.database === 'number' ? plan.database : this.source.database);
    check(signal);
    const send = <T>(command: () => Promise<T>) => this.sharedCommand(command, client);
    if (plan.tool === 'redis_keys') {
      const prefix = Buffer.from(plan.prefix!);
      const pattern = plan.prefix! + '*';
      let [cursor, index] = Array.isArray(plan.position) ? plan.position : ['0', 0];
      let pages = 0, emitted = 0;
      const seen = new Set<string>();
      do {
        check(signal);
        const pageStart = cursor;
        // Preserve exact bytes for both keys and Redis' opaque cursor.
        const [next, keys] = await send(() => client.sendCommand<[Buffer, Buffer[]]>(
          ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '64'], { returnBuffers: true }));
        cursor = next.toString('ascii'); pages++;
        for (; index < keys.length; index++) {
          check(signal);
          const key = keys[index];
          if (!key.subarray(0, prefix.length).equals(prefix)) continue;
          const identity = key.length <= maxRedisReadKeyBytes ? key.toString('base64') : undefined;
          if (identity !== undefined && seen.has(identity)) continue;
          if (emitted === plan.limit) {
            yield new ListProgress([pageStart, index], 'row_limit');
            return;
          }
          if (identity === undefined) throw new SafeError('BUDGET_EXCEEDED');
          const formatted = formatRedisReadKey(key);
          if (Buffer.byteLength(JSON.stringify({ sourceId: this.source.id, database: plan.database, key: formatted })) > this.source.budgets.maxRequestBytes)
            throw new SafeError('BUDGET_EXCEEDED');
          seen.add(identity);
          const position: ListPosition = index + 1 === keys.length && cursor !== '0' ? [cursor, 0] : [pageStart, index + 1];
          yield new ListRow({ key: formatted }, position);
          emitted++;
        }
        if (cursor !== '0' && (emitted === plan.limit || pages >= this.source.budgets.maxScanPages)) {
          yield new ListProgress([cursor, 0], emitted === plan.limit ? 'row_limit' : 'scan_pages');
          return;
        }
        index = 0;
      } while (cursor !== '0');
      return;
    }
    const key = plan.redisKey!;
    const formatted = formatRedisReadKey(key);
    if (plan.tool === 'redis_type') {
      yield { key: formatted, type: await send(() => client.type(key)) };
    } else if (plan.tool === 'redis_memory_usage') {
      const bytes = await send(() => client.sendCommand<number | null>(['MEMORY', 'USAGE', key, 'SAMPLES', '5']));
      yield { key: formatted, bytes };
    } else {
      const offset = plan.offset!;
      const bytes = Math.min(plan.bytes!, Number.MAX_SAFE_INTEGER - offset);
      // GETRANGE includes its upper bound. One lookahead byte detects the end
      // without a separate command or sending that byte to the caller.
      const value = await send(() => client.getRange(commandOptions({ returnBuffers: true }),
        key, offset, offset + bytes))
        .catch(error => {
          if (error instanceof ErrorReply && /^WRONGTYPE(?: |$)/.test(error.message)) throw new SafeError('REDIS_WRONG_TYPE');
          throw error;
        });
      check(signal);
      const buffer = Buffer.from(value);
      const hasMore = buffer.length > bytes;
      if (hasMore && bytes === 0) throw new SafeError('BUDGET_EXCEEDED');
      const fragment = buffer.subarray(0, bytes);
      yield { key: formatted, offset, encoding: 'base64', value: fragment.toString('base64'),
        bytes: fragment.length, complete: offset === 0 && !hasMore, hasMore,
        ...(hasMore ? { nextOffset: offset + fragment.length } : {}), note: 'Empty looks missing. No snapshot.' };
    }
  }
}

// Exactly one fixed, bounded script. Values are ARGV, never concatenated into Lua. Redis 7+
// checks the caller's native command/key ACL within scripts; the model never supplies code.
export const redisCasScript = `
local key = KEYS[1]
local action = ARGV[1]
local kind = redis.call('TYPE', key).ok
if kind ~= 'none' and kind ~= 'string' then return {'conflict'} end
if action == 'create' then
  if kind ~= 'none' then return {'conflict'} end
else
  if kind == 'none' then return {'missing'} end
  if redis.call('STRLEN', key) > tonumber(ARGV[8]) then return {'conflict'} end
  if redis.call('GET', key) ~= ARGV[3] then return {'conflict'} end
  local ttl = redis.call('PTTL', key)
  if ARGV[5] == 'persistent' then
    if ttl ~= -1 then return {'conflict'} end
  elseif ttl < tonumber(ARGV[6]) or ttl > tonumber(ARGV[7]) then return {'conflict'} end
end
if action == 'delete' then redis.call('DEL', key); return {'deleted'} end
if action == 'replace' and ARGV[2] == ARGV[3] and ARGV[4] == 'keep' then return {'no_change'} end
if ARGV[4] == 'keep' then redis.call('SET', key, ARGV[2], 'KEEPTTL')
elseif ARGV[4] == 'clear' then redis.call('SET', key, ARGV[2])
else redis.call('SET', key, ARGV[2], 'EX', ARGV[9]) end
return {action == 'create' and 'inserted' or 'updated'}
`;

export function redisWriteArguments(plan: RedisWritePlan, maxValueBytes: number): string[] {
  return ['EVAL', redisCasScript, '1', plan.target, plan.action, plan.value ?? '', plan.expectedValue ?? '',
    plan.ttl?.mode ?? 'clear', plan.expectedTtl?.mode ?? 'persistent', String(plan.expectedTtl?.mode === 'expiring' ? plan.expectedTtl.minMs : 0),
    String(plan.expectedTtl?.mode === 'expiring' ? plan.expectedTtl.maxMs : 0), String(maxValueBytes), String(plan.ttl?.mode === 'expire' ? plan.ttl.seconds : 0)];
}
