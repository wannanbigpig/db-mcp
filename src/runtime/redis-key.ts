import { isUtf8 } from 'node:buffer';

export const maxRedisReadKeyBytes = 4096;
export const maxRedisReadKeyBase64Length = Math.ceil(maxRedisReadKeyBytes / 3) * 4;

export function parseRedisReadKey(key: unknown): Buffer | undefined {
  if (typeof key === 'string' && key.length <= maxRedisReadKeyBytes) {
    const bytes = Buffer.from(key);
    if (bytes.length <= maxRedisReadKeyBytes && bytes.toString('utf8') === key) return bytes;
  } else if (key && typeof key === 'object' && 'base64' in key &&
      typeof key.base64 === 'string' && key.base64.length <= maxRedisReadKeyBase64Length) {
    const bytes = Buffer.from(key.base64, 'base64');
    if (bytes.length <= maxRedisReadKeyBytes && bytes.toString('base64') === key.base64) return bytes;
  }
}

export function formatRedisReadKey(key: Buffer): string | { base64: string } {
  return isUtf8(key) ? key.toString('utf8') : { base64: key.toString('base64') };
}
