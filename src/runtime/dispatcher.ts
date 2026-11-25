import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SourceRegistry } from './sources.js';
import { definitions, catalog, sourceToolMetadata } from './tool-catalog.js';
import { authorize } from './policy.js';
import { clientErrorDetails, readError, SafeError, safeError } from './errors.js';
import { raceWithAbort } from '../utils/async.js';
import type { Operations } from './operations.js';
import { ListCursors, ListProgress, ListRow, supportsPagination, type ListPosition } from './pagination.js';

type TextResult = CallToolResult & { content: Array<{ type: 'text'; text: string }> };
type TruncationReason = 'item_bytes' | 'response_bytes' | 'row_limit' | 'scan_pages';
const singleResultTools = new Set(['mongodb_find_one', 'redis_get', 'redis_get_range', 'redis_type', 'redis_memory_usage']);

export type AuditEvent = { requestId: string; timestamp?: string; operationId?: string; sourceId?: string;
  tool: string; outcome: string; durationMs: number; rows?: number; directAffected?: number };
export type AuditSink = (event: AuditEvent) => void;

export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

export function response(data: unknown, maxBytes = 65536): TextResult {
  const result: TextResult = { content: [{ type: 'text', text: jsonSafe(data) }] };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new SafeError('BUDGET_EXCEEDED', { reason: 'response_too_large' });
  return result;
}

function readResponse(rows: readonly string[], reason?: TruncationReason, nextCursor?: string): TextResult {
  const text = `{"rows":[${rows.join(',')}],"truncated":${reason !== undefined}${reason ? `,"reason":"${reason}"` : ''}${nextCursor ? `,"nextCursor":"${nextCursor}"` : ''}}`;
  return { content: [{ type: 'text', text }] };
}

function readEnvelopeBytes(reason?: TruncationReason, nextCursor?: string): number {
  return Buffer.byteLength(JSON.stringify(readResponse([], reason, nextCursor)));
}

function checkShape(value: unknown, depth = 0): void {
  if (depth > 8) throw new SafeError('INVALID_ARGUMENT', { reason: 'invalid_shape', path: '$' });
  if (!value || typeof value !== 'object') return;
  if (Object.keys(value).length > 256) throw new SafeError('INVALID_ARGUMENT', { reason: 'invalid_shape', path: '$' });
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new SafeError('INVALID_ARGUMENT', { reason: 'invalid_shape', path: '$' });
    checkShape(item, depth + 1);
  }
}

export class Dispatcher {
  private readonly cursors = new ListCursors();

  constructor(private readonly registry: SourceRegistry, private readonly audit: AuditSink = () => {}, private readonly operations?: Operations) {}

  tools() { return catalog(this.registry.config.sources); }

  async call(name: string, args: unknown, callerSignal?: AbortSignal): Promise<TextResult> {
    const requestId = randomUUID();
    const started = Date.now();
    let sourceId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(new SafeError('REQUEST_CANCELLED', { reason: 'caller_cancelled' }));
    const timeoutError = () => new SafeError('REQUEST_CANCELLED', { reason: 'query_timeout' });
    const expire = () => controller.abort(timeoutError());
    const tool = definitions.find(t => t.name === name);
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    try {
      if (!tool) throw new SafeError('SCOPE_DENIED');
      if (tool.requiresWrite && (!this.operations || this.registry.config.instance.tier !== 'read_write')) throw new SafeError('SCOPE_DENIED');
      checkShape(args);
      if (Buffer.byteLength(jsonSafe(args ?? {})) > this.registry.config.instance.budgets.maxRequestBytes) {
        throw new SafeError('BUDGET_EXCEEDED', { reason: 'request_too_large' });
      }
      const parsed = tool.schema.safeParse(args ?? {});
      if (!parsed.success) {
        const section = parsed.error.issues.find(issue =>
          (issue.code === 'too_big' && issue.origin === 'number' && issue.maximum === Number.MAX_SAFE_INTEGER) ||
          (issue.code === 'too_small' && issue.origin === 'number' && issue.minimum === Number.MIN_SAFE_INTEGER))?.path[0];
        if (section === 'where' || section === 'filter' || section === 'key' || section === 'values') {
          // Only built-in argument names are safe to echo before authorization.
          throw new SafeError('INVALID_ARGUMENT', { path: `$.${section}.*`, reason: 'UNSAFE_INTEGER' });
        }
        const issue = parsed.error.issues[0];
        const [field, index, member] = issue.path;
        // Never echo map keys or values. The bounded orderBy array and its two
        // fixed members are the only nested paths we report.
        let path = typeof field === 'string' && Object.hasOwn(tool.schema.shape, field) ? `$.${field}` : '$';
        if (path === '$.orderBy' && issue.path.length === 3 && typeof index === 'number' && Number.isInteger(index) &&
            index >= 0 && index < 8 && (member === 'field' || member === 'direction')) {
          path += `[${index}].${member}`;
          if (member === 'direction' && issue.code === 'invalid_value') {
            throw new SafeError('INVALID_ARGUMENT', { path, reason: 'invalid_sort_direction' });
          }
        }
        const reason = path === '$.cursor' ? 'invalid_cursor' : issue.code === 'invalid_type' ? 'invalid_type' :
          issue.code === 'unrecognized_keys' ? 'unknown_field' : issue.code === 'too_big' || issue.code === 'too_small' ? 'out_of_range' : 'invalid_value';
        throw new SafeError('INVALID_ARGUMENT', { path, reason });
      }
      const input = parsed.data as Record<string, unknown>;
      controller.signal.throwIfAborted();
      if (name === 'list_sources' || name === 'server_runtime_status') {
        // Include up to 256 scan prefixes of 128 characters each in nested JSON.
        const result = name === 'list_sources' ? response({
          sources: this.registry.list().map(source => ({ ...source, ...sourceToolMetadata(this.registry.get(source.id).config) })),
        }, 160 * 1024) : response({ tier: this.registry.config.instance.tier, concurrency: this.registry.globalLimiter.snapshot(),
          ...(this.operations ? { journalHealthy: this.operations.journal.healthy(), writeBlockedSources: this.operations.blockedSources() } : {}) });
        this.emit({ requestId, tool: name, outcome: 'success', durationMs: Date.now() - started });
        return result;
      }
      const source = this.registry.get(input.sourceId as string);
      sourceId = source.config.id;
      if (tool.requiresWrite) {
        if (Buffer.byteLength(jsonSafe(input)) > source.config.budgets.maxRequestBytes) {
          throw new SafeError('BUDGET_EXCEEDED', { reason: 'request_too_large' });
        }
        timer = setTimeout(expire, source.config.budgets.queryTimeoutMs);
        const data = name === 'operation_status' ? this.operations!.status(sourceId, input.operationId as string) :
          name === 'commit_write' ? await this.operations!.commit(sourceId, input.operationId as string, controller.signal) :
          await this.operations!.prepare(name, input, controller.signal);
        const result = response(data, source.config.budgets.maxResponseBytes);
        this.emit({ requestId, sourceId, tool: name, outcome: typeof data === 'object' && data && 'state' in data ? String(data.state) : 'success',
          ...(typeof data === 'object' && data && 'operationId' in data && typeof data.operationId === 'string' ? { operationId: data.operationId } : {}),
          ...(typeof data === 'object' && data && 'directAffected' in data && typeof data.directAffected === 'number' ? { directAffected: data.directAffected } : {}), durationMs: Date.now() - started });
        return result;
      }
      const plan = authorize(source.config, name, input);
      const budgets = source.config.budgets;
      if (Buffer.byteLength(jsonSafe(input)) > budgets.maxRequestBytes) throw new SafeError('BUDGET_EXCEEDED', { reason: 'request_too_large' });
      const listScope = supportsPagination(name) ? JSON.stringify([name, sourceId, plan.database ?? source.config.database, plan.target, plan.prefix]) : undefined;
      if (listScope && typeof input.cursor === 'string') plan.position = this.cursors.decode(listScope, input.cursor);
      const connection = source.connection;
      const sourceUnavailable = () => new SafeError('SOURCE_UNAVAILABLE', {
        reason: source.status === 'reconnecting' ? 'source_reconnecting' :
          source.status === 'ready' ? 'source_connection_lost' : 'source_unavailable',
      });
      if (source.status !== 'ready' || !connection) throw sourceUnavailable();
      const signal = AbortSignal.any([controller.signal, connection.signal]);
      const checkConnection = () => {
        if (connection.signal.aborted) throw sourceUnavailable();
      };
      const deadline = Date.now() + budgets.queryTimeoutMs;
      timer = setTimeout(expire, budgets.queryTimeoutMs);
      const rows: Array<{ json: string; wireBytes: number; next?: ListPosition }> = [];
      const envelopeBytes = readEnvelopeBytes();
      let rowBytes = 0;
      let reason: TruncationReason | undefined;
      let progress: ListPosition | undefined;
      const check = () => {
        checkConnection();
        controller.signal.throwIfAborted();
        if (Date.now() >= deadline) throw timeoutError();
      };
      const execute = async () => {
        check();
        for await (const item of connection.adapter.read(plan, signal)) {
          check();
          if (item instanceof ListProgress) { progress = item.next; reason = item.reason; break; }
          if (rows.length >= plan.limit) { reason = 'row_limit'; break; }
          const row = item instanceof ListRow ? item : undefined;
          const json = jsonSafe(row ? row.value : item);
          if (Buffer.byteLength(json) > budgets.maxItemBytes) { reason = 'item_bytes'; break; }
          // The row JSON is embedded in the result's text string. Count escaping
          // without re-serializing the rows already collected (minus two quotes).
          const wireBytes = Buffer.byteLength(JSON.stringify(json)) - 2 + (rows.length ? 1 : 0);
          if (envelopeBytes + rowBytes + wireBytes > budgets.maxResponseBytes) { reason = 'response_bytes'; break; }
          rows.push({ json, wireBytes, next: row?.next }); rowBytes += wireBytes;
          if (!listScope && rows.length >= plan.limit) {
            if (!singleResultTools.has(name)) reason = 'row_limit';
            break;
          }
        }
      };
      // Both limiters remain held until the real adapter operation settles, even after timeout.
      const operation = this.registry.globalLimiter.runCancellable(execute, signal, budgets.queueTimeoutMs, source.limiter);
      try { await raceWithAbort(operation, signal); }
      catch (error) { checkConnection(); throw readError(error, source.config.engine); }
      check();
      const continuation = () => {
        const position = progress ?? rows.at(-1)?.next;
        return reason && listScope && position !== undefined ? this.cursors.encode(listScope, position) : undefined;
      };
      let nextCursor = continuation();
      while (reason && readEnvelopeBytes(reason, nextCursor) + rowBytes > budgets.maxResponseBytes) {
        // A cursor must point immediately after the last row actually sent.
        const removed = rows.pop();
        if (!removed) throw new SafeError('BUDGET_EXCEEDED', { reason: 'response_too_large' });
        rowBytes -= removed.wireBytes;
        reason = 'response_bytes';
        progress = undefined;
        nextCursor = continuation();
      }
      if (reason && listScope && !nextCursor) throw new SafeError('BUDGET_EXCEEDED', {
        reason: reason === 'item_bytes' ? 'item_too_large' : 'response_too_large',
      });
      const result = readResponse(rows.map(row => row.json), reason, nextCursor);
      this.emit({ requestId, sourceId, tool: name, outcome: 'success', rows: rows.length, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      controller.abort();
      const sanitized = safeError(error);
      const details = clientErrorDetails(sanitized, !!tool && !tool.mutation);
      this.emit({ requestId, ...(sourceId ? { sourceId } : {}), tool: tool?.name ?? 'unknown',
        outcome: sanitized.code, durationMs: Date.now() - started });
      return { ...response({ error: { code: sanitized.code, message: sanitized.message, requestId,
        ...(details ? { details } : {}) } }, 1024), isError: true };
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  }

  private emit(event: AuditEvent): void { try { this.audit({ ...event, timestamp: new Date().toISOString() }); } catch { /* durable write journal is independent of best-effort audit */ } }
}
