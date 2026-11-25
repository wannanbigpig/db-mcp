import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SafeError } from './errors.js';

export type ListPosition = number | [string, number];

export class ListRow {
  constructor(readonly value: unknown, readonly next: ListPosition) {}
}

// An engine can exhaust its per-call search budget without finding another row.
export class ListProgress {
  constructor(readonly next: ListPosition, readonly reason: 'row_limit' | 'scan_pages') {}
}

const listTools = new Set(['list_databases', 'mysql_list_tables', 'mysql_describe_table', 'mongodb_list_collections', 'redis_keys']);
export const supportsPagination = (tool: string): boolean => listTools.has(tool);

export class ListCursors {
  private readonly key = randomBytes(32);

  private signature(scope: string, payload: string): Buffer {
    return createHmac('sha256', this.key).update(scope).update('\0').update(payload).digest();
  }

  encode(scope: string, position: ListPosition): string {
    const payload = Buffer.from(JSON.stringify(position)).toString('base64url');
    return payload + '.' + this.signature(scope, payload).toString('base64url');
  }

  decode(scope: string, cursor: string): ListPosition {
    const invalid = () => new SafeError('INVALID_ARGUMENT', { reason: 'invalid_cursor', path: '$.cursor' });
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) throw invalid();
    const [, payload, signature] = match;
    const received = Buffer.from(signature, 'base64url');
    if (received.toString('base64url') !== signature || !timingSafeEqual(received, this.signature(scope, payload))) {
      throw invalid();
    }
    // Only the running server's own encoded positions reach this point.
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ListPosition;
  }
}
