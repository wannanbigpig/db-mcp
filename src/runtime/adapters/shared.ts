import { createHash } from 'node:crypto';
import type { SourceConfig } from '../../config/v2.js';
import { SafeError } from '../errors.js';

export type EngineSource<E extends SourceConfig['engine']> = Extract<SourceConfig, { engine: E }>;
export const quote = (name: string) => '`' + name + '`'; // identifiers are authorized before adapter execution
export const check = (signal: AbortSignal) => { if (signal.aborted) throw new SafeError('REQUEST_CANCELLED'); };
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const versionOf = (value: unknown): number => {
  const number = Number(value);
  if (value == null || !Number.isSafeInteger(number) || number < 0) throw new SafeError('SCHEMA_UNSAFE');
  return number;
};

// This only bounds caller waiting. The adapter owns cancellation and cleanup;
// callers must retain capacity until their underlying operation has settled.
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new SafeError('REQUEST_CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
