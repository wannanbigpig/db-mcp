import { raceWithAbort } from '../utils/async.js';
import { SourceRegistry, type SourceConnection } from './sources.js';
import { OperationJournal, type OperationRecord } from './journal.js';
import { authorizeWrite, type WritePlan, type WriteOutcome } from './write-policy.js';
import { sourceAllows } from './tool-catalog.js';
import { SafeError, safeError } from './errors.js';

export class Operations {
  private readonly prepared = new Map<string, { plan: WritePlan; fingerprint: string; lifetime: AbortSignal }>();
  private readonly commits = new Map<string, Promise<OperationRecord & { journalDegraded?: boolean }>>();
  private readonly degradedResults = new Map<string, OperationRecord>();
  private readonly controllers = new Set<AbortController>();
  private readonly active = new Map<Promise<unknown>, { sourceId: string; connection: SourceConnection }>();
  private closed = false;
  constructor(private readonly registry: SourceRegistry, readonly journal: OperationJournal) {}
  blockedSources(): string[] { return this.registry.config.sources.filter(s => this.journal.hasUnknown(s.id)).map(s => s.id); }

  private allowed(sourceId: string, operationId?: string) {
    const source = this.registry.get(sourceId);
    if (source.config.access.tier !== 'read_write') throw new SafeError('SCOPE_DENIED');
    const record = operationId ? this.journal.get(operationId) : undefined;
    if (operationId && (!record || record.sourceId !== sourceId || !sourceAllows(source.config, record.tool))) throw new SafeError('OPERATION_NOT_FOUND');
    return { source, record };
  }

  status(sourceId: string, operationId: string): OperationRecord & { journalDegraded?: boolean } {
    const { record } = this.allowed(sourceId, operationId);
    const result = this.degradedResults.get(operationId) ?? record!;
    const expired = result.state === 'prepared' && !this.commits.has(operationId) &&
      (result.expiresAt <= Date.now() || this.prepared.get(operationId)?.lifetime.aborted);
    return { ...result, ...(expired ? { state: 'not_started' as const, code: 'PREVIEW_EXPIRED' } : {}),
      ...(!this.journal.healthy() ? { journalDegraded: true } : {}) };
  }

  private checkPreviousWrites(sourceId: string, connection: SourceConnection): void {
    for (const pending of this.active.values()) {
      // A recovered connection may serve reads while the old one is still recording a final write outcome.
      if (pending.sourceId === sourceId && pending.connection !== connection) throw new SafeError('SOURCE_UNAVAILABLE');
    }
  }

  async prepare(tool: string, input: Record<string, unknown>, callerSignal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    if (!this.journal.healthy()) throw new SafeError('JOURNAL_UNAVAILABLE');
    const { source } = this.allowed(input.sourceId as string);
    if (this.journal.hasUnknown(source.config.id)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
    const plan = authorizeWrite(source.config, tool, input);
    const connection = source.connection;
    const writer = connection?.adapter.writer;
    if (!connection || !writer || source.status !== 'ready') throw new SafeError('SOURCE_UNAVAILABLE');
    this.checkPreviousWrites(source.config.id, connection);

    const signal = AbortSignal.any([callerSignal, connection.signal]);
    const checkConnection = () => {
      if (connection.signal.aborted) throw new SafeError('SOURCE_UNAVAILABLE');
    };
    const checkAdmission = () => {
      checkConnection();
      if (callerSignal.aborted) throw new SafeError('REQUEST_CANCELLED');
      if (this.journal.hasUnknown(source.config.id)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
    };
    const actual = this.registry.globalLimiter.runCancellable(() => writer.preview(plan, signal),
      signal, source.config.budgets.queueTimeoutMs, source.limiter);
    let preview;
    try { preview = await raceWithAbort(actual, signal); }
    catch (error) {
      checkConnection();
      if (signal.aborted) throw new SafeError('REQUEST_CANCELLED');
      throw error;
    }
    checkAdmission();
    if (preview.condition !== 'match') throw new SafeError(preview.condition === 'missing' ? 'TARGET_NOT_FOUND' : 'VERSION_CONFLICT');
    const disconnectedPreviews = new Set<string>();
    const now = Date.now();
    for (const [id, previous] of this.prepared) {
      const record = this.journal.get(id);
      if (!record || record.expiresAt <= now) this.prepared.delete(id);
      else if (previous.lifetime.aborted && !this.commits.has(id)) disconnectedPreviews.add(id);
    }
    for (const [id] of this.commits) if (!this.journal.get(id)) this.commits.delete(id);
    // Expire stale records and reserve the new preview in the same journal snapshot.
    const record = await this.journal.prepare(source.config.id, tool, disconnectedPreviews, checkAdmission);
    for (const id of disconnectedPreviews) this.prepared.delete(id);
    try { checkAdmission(); }
    catch (error) {
      // No caller can commit an operation ID we have not returned.
      await this.journal.discardUnissuedPreview(record);
      throw error;
    }
    this.prepared.set(record.operationId, { plan, fingerprint: preview.fingerprint, lifetime: connection.signal });
    return { ...record, action: plan.action, directTargets: 1, notice: 'Preview is not human approval, a backup or a guarantee against later conflicts.' };
  }

  commit(sourceId: string, operationId: string, callerSignal: AbortSignal): Promise<OperationRecord & { journalDegraded?: boolean }> {
    const { source, record } = this.allowed(sourceId, operationId);
    const observed = this.status(sourceId, operationId);
    if (observed.state !== 'prepared' && observed.state !== 'pending') {
      if (record!.state === 'prepared' && observed.code === 'PREVIEW_EXPIRED') {
        return this.journal.finish(operationId, { state: 'not_started', code: 'PREVIEW_EXPIRED' });
      }
      return Promise.resolve(observed);
    }
    const existing = this.commits.get(operationId);
    if (existing) return existing;
    if (record!.state !== 'prepared') return Promise.resolve(record!);
    const context = this.prepared.get(operationId);
    if (!context || record!.expiresAt <= Date.now()) return this.journal.finish(operationId, { state: 'not_started', code: 'PREVIEW_EXPIRED' });
    if (this.journal.hasUnknown(sourceId)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    const connection = source.connection;
    const writer = connection?.adapter.writer;
    if (!connection || connection.signal !== context.lifetime || !writer || source.status !== 'ready') throw new SafeError('SOURCE_UNAVAILABLE');
    this.checkPreviousWrites(sourceId, connection);

    const controller = new AbortController(); this.controllers.add(controller);
    const interrupted = AbortSignal.any([callerSignal, connection.signal]);
    const cancellationCode = () => connection.signal.aborted ? 'SOURCE_UNAVAILABLE' : 'REQUEST_CANCELLED';
    const cancel = () => controller.abort();
    interrupted.addEventListener('abort', cancel, { once: true }); if (interrupted.aborted) cancel();
    const timer = setTimeout(cancel, source.config.budgets.queryTimeoutMs);
    let sent = false;
    const finish = async (outcome: WriteOutcome) => {
      try { return await this.journal.finish(operationId, outcome); }
      catch {
        const current = this.degradedResults.get(operationId) ?? this.journal.get(operationId)!;
        if (['success', 'failed', 'not_started'].includes(current.state)) return { ...current, journalDegraded: true };
        const { code: _code, directAffected: _count, effect: _effect, version: _version, ...header } = current;
        const result = { ...header, ...outcome };
        this.degradedResults.set(operationId, result);
        return { ...result, journalDegraded: true };
      }
    };
    const actual = (async () => {
      try {
        await this.journal.pending(operationId);
        const outcome = await this.registry.globalLimiter.runCancellable(async () => {
          if (controller.signal.aborted || this.closed) throw new SafeError(cancellationCode());
          // A different operation may degrade the journal while this durable pending waits.
          if (!this.journal.healthy()) throw new SafeError('JOURNAL_UNAVAILABLE');
          if (this.journal.hasUnknown(sourceId)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
          if (source.connection !== connection || source.status !== 'ready') throw new SafeError('SOURCE_UNAVAILABLE');
          return writer.write(context.plan, context.fingerprint, controller.signal, { sent: () => {
            // Driver setup/metadata checks can await after admission. Recheck synchronously
            // at the first DML boundary; already sent writes remain in-flight, not retried.
            if (controller.signal.aborted || this.closed) throw new SafeError(cancellationCode());
            if (!this.journal.healthy()) throw new SafeError('JOURNAL_UNAVAILABLE');
            if (this.journal.hasUnknown(sourceId)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
            if (source.connection !== connection || source.status !== 'ready') throw new SafeError('SOURCE_UNAVAILABLE');
            sent = true;
          } });
        }, controller.signal, source.config.budgets.queueTimeoutMs, source.limiter);
        return await finish(outcome);
      } catch (error) {
        return await finish({ state: sent ? 'unknown_outcome' : 'not_started', code: sent ? 'WRITE_OUTCOME_UNKNOWN' : controller.signal.aborted ? cancellationCode() : safeError(error).code });
      } finally {
        this.prepared.delete(operationId); clearTimeout(timer);
        interrupted.removeEventListener('abort', cancel); this.controllers.delete(controller);
      }
    })();
    this.active.set(actual, { sourceId, connection }); void actual.finally(() => this.active.delete(actual)).catch(() => {});
    const result = (async () => {
      let onAbort: () => void = () => {};
      const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined);
        controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
      try {
        const confirmed = await Promise.race([actual, aborted]);
        if (confirmed) return confirmed;
        return await finish({ state: sent ? 'unknown_outcome' : 'not_started', code: sent ? 'WRITE_OUTCOME_UNKNOWN' : cancellationCode() });
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    })();
    this.commits.set(operationId, result);
    return result;
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await this.registry.close();
    await Promise.allSettled([...this.active.keys()]);
    await this.journal.close();
  }
}
