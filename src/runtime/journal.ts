import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isUtf8 } from 'node:buffer';
import { SafeError } from './errors.js';
import type { WriteOutcome } from './write-policy.js';

export type JournalOptions = { directory: string; maxOperations: number; retentionDays: number; previewTtlMs: number; maxPrepared: number };
const recordSchema = z.object({ operationId: z.string().uuid(), sourceId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  tool: z.enum(['mysql_prepare_write', 'redis_prepare_write', 'mongodb_prepare_write']),
  state: z.enum(['prepared', 'pending', 'not_started', 'success', 'failed', 'unknown_outcome']),
  createdAt: z.number().int(), expiresAt: z.number().int(), retainUntil: z.number().int(), generation: z.string().uuid(),
  code: z.string().regex(/^[A-Z_]{1,64}$/).optional(), directAffected: z.number().int().min(0).max(1).optional(),
  effect: z.enum(['inserted', 'updated', 'deleted', 'no_change']).optional(), version: z.number().int().min(0).optional(),
}).strict();
export type OperationRecord = z.infer<typeof recordSchema>;
const snapshotSchema = z.object({ version: z.literal(1), instance: z.string().min(1).max(64),
  records: z.array(recordSchema).max(10000) }).strict();

// Single local writer. A leftover crash lock is deliberately not auto-deleted: the operator
// must stop all instances and remove that exact lock before recovery. No PID/lease guessing.
export class OperationJournal {
  private records = new Map<string, OperationRecord>();
  private readonly unpersistedUnknown = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  readonly generation = randomUUID();
  private constructor(readonly options: JournalOptions, private readonly instance: string,
    private readonly lock: Awaited<ReturnType<typeof open>>) {}

  static async open(options: JournalOptions, instance: string): Promise<OperationJournal> {
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let journal: OperationJournal | undefined;
    try {
      if (!process.getuid || !path.isAbsolute(options.directory)) throw new Error();
      const dir = await lstat(options.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error();
      lock = await open(path.join(options.directory, 'writer.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, generation: randomUUID() })); await lock.sync();
      journal = new OperationJournal(options, instance, lock);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(path.join(options.directory, 'operations.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 4 * 1024 * 1024) throw new Error();
        const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== info.size || bytesRead > 4 * 1024 * 1024 || !isUtf8(bytes.subarray(0, bytesRead))) throw new Error();
        const snapshot = snapshotSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
        if (snapshot.instance !== instance || new Set(snapshot.records.map(r => r.operationId)).size !== snapshot.records.length || snapshot.records.length > options.maxOperations) throw new Error();
        for (const record of snapshot.records) {
          if (record.state === 'pending') { record.state = 'unknown_outcome'; record.code = 'WRITE_OUTCOME_UNKNOWN'; }
          if (record.state === 'prepared') { record.state = 'not_started'; record.code = 'PREVIEW_EXPIRED'; }
          journal.records.set(record.operationId, record);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { await file?.close(); }
      await journal.persist(journal.records);
      return journal;
    } catch {
      if (lock) { await lock.close().catch(() => {}); await unlink(path.join(options.directory, 'writer.lock')).catch(() => {}); }
      throw new SafeError('JOURNAL_UNAVAILABLE');
    }
  }

  get(id: string): OperationRecord | undefined {
    const record = this.records.get(id);
    return record && (record.retainUntil >= Date.now() || ['pending', 'unknown_outcome'].includes(record.state)) ? { ...record } : undefined;
  }
  healthy(): boolean { return !this.failed && !this.closed; }
  hasUnknown(sourceId: string): boolean {
    return [...this.unpersistedUnknown.values()].includes(sourceId) ||
      [...this.records.values()].some(record => record.sourceId === sourceId && record.state === 'unknown_outcome');
  }

  private change(fn: (draft: Map<string, OperationRecord>) => OperationRecord): Promise<OperationRecord> {
    const operation = this.tail.then(async () => {
      if (!this.healthy()) throw new SafeError('JOURNAL_UNAVAILABLE');
      // Updates replace records in the draft. Readers keep using the last snapshot
      // whose file and directory have both been synced.
      const draft = new Map(this.records);
      const result = fn(draft);
      try { await this.persist(draft); } catch { this.failed = true; throw new SafeError('JOURNAL_UNAVAILABLE'); }
      this.records = draft;
      return { ...result };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  prepare(sourceId: string, tool: string, disconnectedPreviews?: ReadonlySet<string>, checkAdmission?: () => void): Promise<OperationRecord> {
    return this.change(draft => {
      checkAdmission?.();
      const now = Date.now();
      for (const [id, record] of draft) {
        if (!['pending', 'unknown_outcome'].includes(record.state) && record.retainUntil < now) {
          draft.delete(id);
        } else if (record.state === 'prepared' && (record.expiresAt <= now || disconnectedPreviews?.has(id))) {
          draft.set(id, { ...record, state: 'not_started', code: 'PREVIEW_EXPIRED' });
        }
      }
      if (draft.size >= this.options.maxOperations || [...draft.values()].filter(r => r.state === 'prepared').length >= this.options.maxPrepared) throw new SafeError('BUDGET_EXCEEDED');
      const record = recordSchema.parse({ operationId: randomUUID(), sourceId, tool, state: 'prepared', createdAt: now,
        expiresAt: now + this.options.previewTtlMs, retainUntil: now + this.options.retentionDays * 86400000, generation: this.generation });
      draft.set(record.operationId, record); return record;
    });
  }

  async discardUnissuedPreview(reservation: OperationRecord): Promise<void> {
    if (!this.records.has(reservation.operationId)) return;
    await this.change(draft => {
      const record = draft.get(reservation.operationId);
      if (record) {
        // Another prepare may expire this reservation while cleanup is queued.
        const expired = record.state === 'not_started' && record.code === 'PREVIEW_EXPIRED';
        if (record.generation !== this.generation || record.generation !== reservation.generation ||
            (record.state !== 'prepared' && !expired)) {
          throw new SafeError('PREVIEW_EXPIRED');
        }
        draft.delete(record.operationId);
      }
      return reservation;
    });
  }

  pending(id: string): Promise<OperationRecord> {
    return this.change(draft => {
      const record = draft.get(id);
      if (!record || record.state !== 'prepared' || record.generation !== this.generation || record.expiresAt <= Date.now()) throw new SafeError('PREVIEW_EXPIRED');
      const pending = { ...record, state: 'pending' } as const;
      draft.set(id, pending); return pending;
    });
  }

  finish(id: string, outcome: WriteOutcome): Promise<OperationRecord> {
    const current = this.records.get(id);
    // Uncertainty must block new writes even while the snapshot waits its turn.
    // A failed save leaves this guard in place and disables all new writes.
    if (outcome.state === 'unknown_outcome' && current?.state === 'pending') this.unpersistedUnknown.set(id, current.sourceId);
    return this.change(draft => {
      const record = draft.get(id);
      if (!record) throw new SafeError('OPERATION_NOT_FOUND');
      if (['success', 'failed', 'not_started'].includes(record.state)) return record;
      // A late database acknowledgement can refine an in-process unknown, never trigger replay.
      const { code: _code, directAffected: _count, effect: _effect, version: _version, ...header } = record;
      const finished = { ...header, ...outcome };
      draft.set(id, finished); return finished;
    }).then(record => {
      this.unpersistedUnknown.delete(id);
      return record;
    });
  }

  private async persist(records: ReadonlyMap<string, OperationRecord>): Promise<void> {
    const encoded = JSON.stringify({ version: 1, instance: this.instance, records: [...records.values()] });
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error();
    const temporary = path.join(this.options.directory, 'snapshot-' + randomUUID() + '.tmp');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path.join(this.options.directory, 'operations.json'));
      const dir = await open(this.options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.lock.close();
    await unlink(path.join(this.options.directory, 'writer.lock'));
  }
}
