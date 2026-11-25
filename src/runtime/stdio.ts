import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { SafeError } from './errors.js';

/** Bound individual newline-delimited messages, not arbitrary OS input chunks. */
export class BoundedStdioTransport implements Transport {
  private started = false;
  private stopped = false;
  private readonly frame: Buffer;
  private bufferedBytes = 0;
  private readonly pendingSends = new Set<{ resolve(): void; reject(error: Error): void }>();
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];

  constructor(private readonly input: Readable, private readonly output: Writable,
    maxInputBytes: number, private readonly maxOutputBytes = 2 * 1024 * 1024) {
    this.frame = Buffer.allocUnsafe(maxInputBytes);
    this.output.on('drain', this.onDrain).on('error', this.onStreamError).on('close', this.onEnd);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new SafeError('SERVER_CLOSED');
    if (this.started) throw new Error('Stdio transport already started');
    this.started = true;
    this.input.on('data', this.onData).on('error', this.onStreamError).on('end', this.onEnd);
  }

  private readonly onData = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (!this.stopped && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline + 1;
      const length = end - offset;
      // Include the newline in the frame budget, as the original transport did.
      if (this.bufferedBytes + length > this.frame.length) {
        this.onStreamError(new SafeError('BUDGET_EXCEEDED')); return;
      }
      chunk.copy(this.frame, this.bufferedBytes, offset, end);
      this.bufferedBytes += length; offset = end;
      if (newline === -1) return;
      const line = this.frame.toString('utf8', 0, this.bufferedBytes - 1).replace(/\r$/, '');
      this.bufferedBytes = 0;
      try { this.onmessage?.(deserializeMessage(line)); }
      catch (error) { this.onerror?.(error instanceof Error ? error : new Error('Invalid stdio message')); }
    }
  };

  private readonly onDrain = (): void => {
    for (const pending of this.pendingSends) pending.resolve();
    this.pendingSends.clear();
  };

  private readonly onStreamError = (error: Error): void => {
    if (this.stopped) return;
    this.onerror?.(error);
    void this.close();
  };

  private readonly onEnd = (): void => { void this.close(); };

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.stopped) throw new SafeError('SERVER_CLOSED');
    const encoded = serializeMessage(message);
    if (this.output.writableLength + Buffer.byteLength(encoded) > this.maxOutputBytes) {
      await this.close(); throw new SafeError('BUDGET_EXCEEDED');
    }
    // A single drain listener serves all blocked sends. Closing rejects every
    // waiter, so a client that stops reading cannot retain unresolved requests.
    if (this.output.write(encoded)) return;
    if (this.stopped) throw new SafeError('SERVER_CLOSED');
    await new Promise<void>((resolve, reject) => { this.pendingSends.add({ resolve, reject }); });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.bufferedBytes = 0;
    this.input.off('data', this.onData).off('error', this.onStreamError).off('end', this.onEnd);
    if (this.input.listenerCount('data') === 0) this.input.pause();
    this.output.off('drain', this.onDrain).off('error', this.onStreamError).off('close', this.onEnd);
    for (const pending of this.pendingSends) pending.reject(new SafeError('SERVER_CLOSED'));
    this.pendingSends.clear();
    this.onclose?.();
  }
}
