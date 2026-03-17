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

  if (typeof data === 'object' && data !== null) {
    if (seen.has(data)) {
      return '[Circular]';
    }

    seen.add(data);
    const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => [
      key,
      sanitizeForResponse(value, seen),
    ]);
    return Object.fromEntries(entries);
  }

  return data;
}

function safeStringify(data: unknown): string {
  const serialized = JSON.stringify(sanitizeForResponse(data), null, 2) ?? 'null';
  if (Buffer.byteLength(serialized, 'utf8') <= responseLimits.maxResponseBytes) {
    return serialized;
  }

  return `${serialized.slice(0, responseLimits.maxResponseBytes)}\n... [响应已截断]`;
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
  return {
    content: [
      {
        type: 'text',
        text: `错误: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}
