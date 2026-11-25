import { withTimeout } from './async.js';
import { SafeError } from '../runtime/errors.js';

type Waiter = { limiters: ConcurrencyLimiter[]; grant(): void; reject(error: Error): void };

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxConcurrent: number, private readonly maxQueued = 100) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0 || !Number.isInteger(maxQueued) || maxQueued <= 0) {
      throw new Error('maxConcurrent 和 maxQueued 必须是正整数');
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  // Timeout here bounds only the queue. Active capacity is retained until task cleanup settles.
  // A shared waiter acquires both instance/source permits together. Waiting for one
  // must neither reserve the other nor evade either limiter's queue budget.
  async runCancellable<T>(task: () => Promise<T>, signal: AbortSignal, queueTimeoutMs: number, scope?: ConcurrencyLimiter): Promise<T> {
    await this.acquire(queueTimeoutMs, undefined, signal, scope);
    try {
      if (signal.aborted) throw new SafeError('REQUEST_CANCELLED');
      return await task();
    } finally { this.release(scope); }
  }

  async runWithTimeout<T>(task: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const started = Date.now();
    await this.acquire(timeoutMs, message);
    let operation: Promise<T>;
    try {
      operation = Promise.resolve().then(task);
    } catch (error) {
      this.release();
      throw error;
    }
    void operation.then(() => this.release(), () => this.release());
    const remaining = timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - started)) : 0;
    return withTimeout(operation, remaining, message);
  }

  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  private async acquire(timeoutMs = 0, timeoutMessage = '等待执行超时', signal?: AbortSignal, scope?: ConcurrencyLimiter): Promise<void> {
    const limiters = scope && scope !== this ? [this, scope] : [this];
    if (signal?.aborted) throw new SafeError('REQUEST_CANCELLED');
    if (limiters.every(limiter => limiter.active < limiter.maxConcurrent)) {
      for (const limiter of limiters) limiter.active += 1;
      return;
    }

    if (limiters.some(limiter => limiter.queue.length >= limiter.maxQueued)) {
      if (signal) throw new SafeError('BUDGET_EXCEEDED', { reason: 'queue_full' });
      throw new Error(`并发等待队列已满（上限 ${this.maxQueued}）`);
    }

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const remove = () => {
        for (const limiter of limiters) {
          const index = limiter.queue.indexOf(entry);
          if (index >= 0) limiter.queue.splice(index, 1);
        }
      };
      const cancel = () => entry.reject(new SafeError('REQUEST_CANCELLED'));
      const entry: Waiter = {
        limiters,
        grant: () => {
          remove(); cleanup();
          for (const limiter of limiters) limiter.active += 1;
          resolve();
        },
        reject: error => { remove(); cleanup(); reject(error); },
      };
      for (const limiter of limiters) limiter.queue.push(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => entry.reject(signal
          ? new SafeError('REQUEST_CANCELLED', { reason: 'queue_timeout' }) : new Error(timeoutMessage)), timeoutMs);
      }
    });
  }

  private release(scope?: ConcurrencyLimiter): void {
    const limiters = scope && scope !== this ? [this, scope] : [this];
    for (const limiter of limiters) limiter.active = Math.max(limiter.active - 1, 0);
    for (const limiter of limiters) {
      // Keep FIFO among eligible requests, while bypassing a source that is full.
      for (const entry of [...limiter.queue]) {
        if (entry.limiters.every(candidate => candidate.active < candidate.maxConcurrent)) entry.grant();
      }
    }
  }
}
