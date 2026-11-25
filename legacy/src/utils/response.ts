const responseLimits = {
  maxResultItems: 200,
  maxResponseBytes: 65536,
};

export function configureResponseLimits(options: {
  maxResultItems?: number;
  maxResponseBytes?: number;
}) {
  if (options.maxResultItems !== undefined && options.maxResultItems > 0) {
    responseLimits.maxResultItems = options.maxResultItems;
  }

  if (options.maxResponseBytes !== undefined && options.maxResponseBytes > 0) {
    responseLimits.maxResponseBytes = options.maxResponseBytes;
  }
}

function sanitizeForResponse(data: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof data === 'bigint') {
    return data.toString();
  }

  if (typeof data === 'object' && data !== null) {
    if (seen.has(data)) {
      return '[Circular]';
    }

    seen.add(data);
    try {
      if (Array.isArray(data)) {
        const truncated = data.slice(0, responseLimits.maxResultItems).map((item) => sanitizeForResponse(item, seen));
        if (data.length > responseLimits.maxResultItems) {
          truncated.push({
            __truncated: true,
            omittedItems: data.length - responseLimits.maxResultItems,
          });
        }
        return truncated;
      }

      const jsonValue = (data as { toJSON?: () => unknown }).toJSON?.();
      if (jsonValue !== undefined && jsonValue !== data) {
        return sanitizeForResponse(jsonValue, seen);
      }

      const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        sanitizeForResponse(value, seen),
      ]);
      return Object.fromEntries(entries);
    } finally {
      seen.delete(data);
    }
  }

  return data;
}

function truncateText(text: string, maxBytes: number): string {
  const suffix = '\n... [响应已截断]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) {
    return '.'.repeat(maxBytes);
  }
  const available = maxBytes - suffixBytes;
  let preview = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > available) break;
    preview += character;
    used += size;
  }
  return preview + suffix;
}

function safeStringify(data: unknown): string {
  const serialized = JSON.stringify(sanitizeForResponse(data), null, 2) ?? 'null';
  if (Buffer.byteLength(serialized, 'utf8') <= responseLimits.maxResponseBytes) {
    return serialized;
  }

  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  const minimal = JSON.stringify({ __truncated: true });
  if (Buffer.byteLength(minimal, 'utf8') > responseLimits.maxResponseBytes) {
    return truncateText(minimal, responseLimits.maxResponseBytes);
  }

  const envelope = (preview: string) => JSON.stringify({ __truncated: true, originalBytes, preview });
  let low = 0;
  let high = serialized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = envelope(serialized.slice(0, mid));
    if (Buffer.byteLength(candidate, 'utf8') <= responseLimits.maxResponseBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const result = envelope(serialized.slice(0, low));
  return Buffer.byteLength(result, 'utf8') <= responseLimits.maxResponseBytes ? result : minimal;
}

export function buildSuccessResponse(data: unknown, text?: string) {
  let output = '';

  if (text) {
    output = text;
  } else if (typeof data === 'string') {
    output = data;
  } else if (data === undefined) {
    output = 'null';
  } else {
    output = safeStringify(data);
  }

  if (Buffer.byteLength(output, 'utf8') > responseLimits.maxResponseBytes) {
    output = typeof data === 'string' || text
      ? truncateText(output, responseLimits.maxResponseBytes)
      : safeStringify(data);
  }

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

export function buildErrorResponse(error: unknown) {
  const message = `错误: ${error instanceof Error ? error.message : String(error)}`;
  return {
    content: [
      {
        type: 'text',
        text: Buffer.byteLength(message, 'utf8') > responseLimits.maxResponseBytes
          ? truncateText(message, responseLimits.maxResponseBytes)
          : message,
      },
    ],
    isError: true,
  };
}
