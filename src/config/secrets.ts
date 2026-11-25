import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { SafeError } from '../runtime/errors.js';

const MAX_SECRET_BYTES = 65536;

export async function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
      const value = env[ref.slice(4)];
      if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES || value.includes('\0')) throw new Error();
      return value;
    }
    if (!ref.startsWith('file:') || !path.isAbsolute(ref.slice(5)) || !process.getuid) throw new Error();
    const handle = await open(ref.slice(5), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_SECRET_BYTES) throw new Error();
      bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_SECRET_BYTES || !isUtf8(bytes.subarray(0, total))) throw new Error();
      // Remove a mounted secret's trailing line ending, not password spaces.
      const value = bytes.subarray(0, total).toString('utf8').replace(/\r?\n$/, '');
      bytes.fill(0);
      if (!value || value.includes('\0')) throw new Error();
      return value;
    } finally { bytes?.fill(0); await handle.close(); }
  } catch { throw new SafeError('SECRET_UNAVAILABLE'); }
}
