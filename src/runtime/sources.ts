import type { SourceConfig, V2Config } from '../config/v2.js';
import type { ReadPlan } from './policy.js';
import { SafeError, connectionError, type ErrorCode } from './errors.js';
import { ConcurrencyLimiter } from '../utils/concurrency.js';
import { raceWithAbort } from '../utils/async.js';
import type { WriteAdapter } from './write-policy.js';

export interface ReadAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  read(plan: ReadPlan, signal: AbortSignal): AsyncIterable<unknown>;
  writer?: WriteAdapter;
  onUnavailable?(callback: (code: ErrorCode) => void): void;
}
export type AdapterFactory = (source: SourceConfig, config: V2Config) => Promise<ReadAdapter>;
export type SourceConnection = Readonly<{ adapter: ReadAdapter; signal: AbortSignal }>;
export type RegisteredSource = Readonly<{
  config: SourceConfig;
  connection?: SourceConnection;
  status: 'ready' | 'unavailable' | 'reconnecting';
  errorCode?: ErrorCode;
  limiter: ConcurrencyLimiter;
}>;
type ManagedConnection = SourceConnection & { abort(reason: SafeError): void };
type SourceEntry = {
  config: SourceConfig;
  connection?: ManagedConnection;
  status: RegisteredSource['status'];
  errorCode?: ErrorCode;
  limiter: ConcurrencyLimiter;
  retryCount: number;
  retryTimer?: NodeJS.Timeout;
  attempt?: Promise<void>;
  retiring?: Promise<void>;
};

const transient = new Set<ErrorCode>(['SSH_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'REQUEST_CANCELLED']);

export class SourceRegistry {
  private readonly sources = new Map<string, SourceEntry>();
  private closed = false;
  private initialized = false;
  private closing?: Promise<void>;
  readonly globalLimiter: ConcurrencyLimiter;

  constructor(readonly config: V2Config, private readonly factory: AdapterFactory) {
    this.globalLimiter = new ConcurrencyLimiter(config.instance.budgets.maxConcurrent, config.instance.budgets.maxQueued);
    for (const source of config.sources) {
      this.sources.set(source.id, { config: source, status: 'unavailable', retryCount: 0,
        limiter: new ConcurrencyLimiter(Math.min(source.budgets.maxConcurrent, source.budgets.maxConnections), source.budgets.maxQueued) });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.closed) throw new SafeError('SERVER_CLOSED');
    this.initialized = true;
    const background: SourceEntry[] = [];
    for (const source of this.sources.values()) {
      if (this.closed) throw new SafeError('SERVER_CLOSED');
      if (source.config.ssh && !source.config.required) { background.push(source); continue; }
      try { await this.start(source); }
      catch (error) {
        if (this.closed) throw new SafeError('SERVER_CLOSED');
        const code = connectionError(error, source.config.engine).code;
        if (source.config.required) { await this.close(); throw new SafeError(code); }
        this.unavailable(source, code);
      }
    }
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    for (const source of background) {
      source.status = 'reconnecting';
      this.startInBackground(source);
    }
  }

  private start(source: SourceEntry): Promise<void> {
    const attempt = this.open(source).finally(() => { source.attempt = undefined; });
    source.attempt = attempt;
    return attempt;
  }

  private startInBackground(source: SourceEntry): void {
    if (this.closed) return;
    void this.start(source).catch(error => {
      if (!this.closed) this.unavailable(source, connectionError(error, source.config.engine).code);
    });
  }

  private async open(source: SourceEntry): Promise<void> {
    // The old session must finish closing before a replacement consumes its connection budget.
    if (source.retiring) await source.retiring;
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    const adapter = await this.factory(source.config, this.config);
    if (this.closed) { await adapter.close().catch(() => {}); throw new SafeError('SERVER_CLOSED'); }

    const lifetime = new AbortController();
    const connection: ManagedConnection = { adapter, signal: lifetime.signal, abort: reason => lifetime.abort(reason) };
    source.connection = connection;
    let failedWhileConnecting: ErrorCode | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      adapter.onUnavailable?.(code => {
        if (this.closed || source.connection !== connection) return;
        if (source.status === 'ready') this.unavailable(source, code);
        else failedWhileConnecting = code;
      });
      timer = setTimeout(() => connection.abort(new SafeError('REQUEST_CANCELLED')), source.config.budgets.connectTimeoutMs);
      await raceWithAbort(adapter.connect(), lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (this.closed) throw new SafeError('SERVER_CLOSED');
      if (failedWhileConnecting) throw new SafeError(failedWhileConnecting);
      source.status = 'ready';
      source.errorCode = undefined;
      source.retryCount = 0;
    } catch (error) {
      const reason = connectionError(error, source.config.engine);
      if (source.connection === connection) await this.retire(source, reason);
      throw reason;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private retire(source: SourceEntry, reason: SafeError): Promise<void> | undefined {
    const connection = source.connection;
    if (!connection) return source.retiring;
    source.connection = undefined;
    connection.abort(reason);
    const retiring = Promise.resolve().then(() => connection.adapter.close()).catch(() => {});
    source.retiring = retiring;
    void retiring.then(() => { if (source.retiring === retiring) source.retiring = undefined; });
    return retiring;
  }

  private unavailable(source: SourceEntry, code: ErrorCode): void {
    source.errorCode = code;
    source.status = source.config.ssh && transient.has(code) ? 'reconnecting' : 'unavailable';
    this.retire(source, new SafeError(code));
    if (this.closed || source.status !== 'reconnecting' || source.retryTimer) return;
    const backoff = Math.min(30000, 500 * 2 ** Math.min(source.retryCount++, 6));
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.2));
    source.retryTimer = setTimeout(() => {
      source.retryTimer = undefined;
      this.startInBackground(source);
    }, delay);
    source.retryTimer.unref();
  }

  get(id: string): RegisteredSource {
    if (this.closed) throw new SafeError('SERVER_CLOSED');
    const source = this.sources.get(id);
    if (!source) throw new SafeError('SCOPE_DENIED');
    return source;
  }

  list() {
    return [...this.sources.values()].map(s => ({ id: s.config.id, engine: s.config.engine, purpose: s.config.purpose,
      status: s.status, ...(s.errorCode ? { errorCode: s.errorCode } : {}) }));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.all([...this.sources.values()].map(async source => {
      if (source.retryTimer) clearTimeout(source.retryTimer);
      source.status = 'unavailable';
      const retiring = this.retire(source, new SafeError('SERVER_CLOSED'));
      await Promise.allSettled([retiring, source.attempt]);
    })).then(() => {});
    return this.closing;
  }
}
