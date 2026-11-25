import type { SourceConfig } from '../config/v2.js';
import { SafeError } from './errors.js';
import { sourceAllows } from './tool-catalog.js';

type WriteTarget = { tool: string; sourceId: string; target: string };
type VersionedWritePlan<E extends 'mysql' | 'mongodb'> = WriteTarget & {
  engine: E; key: Record<string, unknown>; versionColumn: string;
} & (
  | { action: 'insert'; values: Record<string, unknown>; expectedVersion?: never }
  | { action: 'update'; values: Record<string, unknown>; expectedVersion: number }
  | { action: 'delete'; values?: never; expectedVersion: number }
);
export type MysqlWritePlan = VersionedWritePlan<'mysql'>;
export type MongoWritePlan = VersionedWritePlan<'mongodb'>;
export type RedisTtl = { mode: 'keep' } | { mode: 'clear' } | { mode: 'expire'; seconds: number };
export type RedisExpectedTtl = { mode: 'persistent' } | { mode: 'expiring'; minMs: number; maxMs: number };
export type RedisWritePlan = WriteTarget & { engine: 'redis' } & (
  | { action: 'create'; value: string; ttl: Exclude<RedisTtl, { mode: 'keep' }>; expectedValue?: never; expectedTtl?: never }
  | { action: 'replace'; value: string; ttl: RedisTtl; expectedValue: string; expectedTtl: RedisExpectedTtl }
  | { action: 'delete'; value?: never; ttl?: never; expectedValue: string; expectedTtl: RedisExpectedTtl }
);
export type WritePlan = MysqlWritePlan | MongoWritePlan | RedisWritePlan;
export type WriteOutcome = { state: 'not_started' | 'success' | 'failed' | 'unknown_outcome';
  code?: string; directAffected?: number; effect?: 'inserted' | 'updated' | 'deleted' | 'no_change'; version?: number };
export type WritePreview = { fingerprint: string; condition: 'match' | 'missing' | 'conflict' };
// Call immediately before the first mutating command, before marking it sent.
// The synchronous gate can reject without DML after asynchronous driver setup.
export interface WriteHooks { sent(): void }
export interface WriteAdapter {
  preview(plan: WritePlan, signal: AbortSignal): Promise<WritePreview>;
  write(plan: WritePlan, fingerprint: string, signal: AbortSignal, hooks: WriteHooks): Promise<WriteOutcome>;
}

export function authorizeWrite(source: SourceConfig, tool: string, input: Record<string, unknown>): WritePlan {
  if (source.access.tier !== 'read_write' || !source.access.writes || !sourceAllows(source, tool)) throw new SafeError('SCOPE_DENIED');
  const action = input.action as WritePlan['action'];
  if (source.engine === 'redis') {
    const key = input.key as string, writes = source.access.writes;
    if (typeof key !== 'string' || !source.access.keyPrefixes.some(p => key.startsWith(p)) ||
        !(action === 'create' ? writes.allowCreate : action === 'replace' ? writes.allowReplace : action === 'delete' && writes.allowDelete)) throw new SafeError('SCOPE_DENIED');
    const ttl = input.ttl as RedisTtl | undefined;
    if ((action === 'delete' && (input.value !== undefined || ttl !== undefined)) ||
        (action !== 'delete' && typeof input.value !== 'string') ||
        (action === 'create' && (input.expectedValue !== undefined || input.expectedTtl !== undefined))) throw new SafeError('INVALID_ARGUMENT');
    const expectation = input.expectedTtl as RedisExpectedTtl | undefined;
    if (expectation?.mode === 'expiring' && expectation.minMs > expectation.maxMs) throw new SafeError('INVALID_ARGUMENT');
    if (action !== 'delete' && (!ttl || (action === 'create' && ttl.mode === 'keep') ||
        (ttl.mode === 'expire' && (!ttl.seconds || ttl.seconds > writes.maxTtlSeconds)))) throw new SafeError('INVALID_ARGUMENT');
    if (action !== 'create' && (typeof input.expectedValue !== 'string' || !input.expectedTtl)) throw new SafeError('INVALID_ARGUMENT');
    for (const value of [input.value, input.expectedValue]) if (typeof value === 'string' && Buffer.byteLength(value) > Math.min(4096, source.budgets.maxItemBytes)) throw new SafeError('BUDGET_EXCEEDED');
    const target = { engine: 'redis' as const, tool, sourceId: source.id, target: key };
    if (action === 'create' && typeof input.value === 'string' && ttl && ttl.mode !== 'keep') {
      return { ...target, action, value: input.value, ttl };
    }
    if (typeof input.expectedValue !== 'string' || !expectation) throw new SafeError('INVALID_ARGUMENT');
    if (action === 'delete') return { ...target, action, expectedValue: input.expectedValue, expectedTtl: expectation };
    if (action === 'replace' && typeof input.value === 'string' && ttl) {
      return { ...target, action, value: input.value, ttl, expectedValue: input.expectedValue, expectedTtl: expectation };
    }
    throw new SafeError('INVALID_ARGUMENT');
  }
  const target = input[source.engine === 'mysql' ? 'table' : 'collection'] as string;
  const policy = source.engine === 'mysql' ? source.access.writes.tables[target] : source.access.writes.collections[target];
  if (!policy || !(action === 'insert' ? policy.allowInsert : action === 'update' ? policy.allowUpdate : action === 'delete' && policy.allowDelete)) throw new SafeError('SCOPE_DENIED');
  const keys: string[] = 'keyColumns' in policy ? policy.keyColumns as string[] : ['_id'];
  const key = input.key as Record<string, unknown>;
  if (!key || Object.keys(key).length !== keys.length || keys.some(k => !Object.hasOwn(key, k) || key[k] == null)) throw new SafeError('INVALID_ARGUMENT');
  const values = input.values as Record<string, unknown> | undefined;
  if (action === 'delete' ? values !== undefined : !values || !Object.keys(values).length) throw new SafeError('INVALID_ARGUMENT');
  if (values && Object.keys(values).some(k => !policy.writableColumns.includes(k))) throw new SafeError('SCOPE_DENIED');
  if (action !== 'insert' && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0)) throw new SafeError('INVALID_ARGUMENT');
  if (action === 'insert' && input.expectedVersion !== undefined) throw new SafeError('INVALID_ARGUMENT');
  const identity = { tool, sourceId: source.id, target, key, versionColumn: policy.versionColumn };
  const changes = action === 'insert' && values ? { action, values } :
    action === 'update' && values ? { action, values, expectedVersion: input.expectedVersion as number } :
    action === 'delete' ? { action, expectedVersion: input.expectedVersion as number } : undefined;
  if (!changes) throw new SafeError('INVALID_ARGUMENT');
  return source.engine === 'mysql' ? { ...identity, ...changes, engine: 'mysql' } : { ...identity, ...changes, engine: 'mongodb' };
}
