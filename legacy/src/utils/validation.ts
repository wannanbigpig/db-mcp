function getValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

export function assertRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} 必须是对象，当前为 ${getValueType(value)}`);
  }

  return value as Record<string, unknown>;
}

export function assertNonEmptyRecord(value: unknown, fieldName: string): Record<string, unknown> {
  const record = assertRecord(value, fieldName);
  if (Object.keys(record).length === 0) {
    throw new Error(`${fieldName} 不能为空对象`);
  }
  return record;
}

export function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} 必须是非空字符串`);
  }
  return value;
}

export function assertText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} 必须是字符串`);
  }
  return value;
}

export function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${fieldName} 必须是字符串数组`);
  }
  return value;
}

export function assertArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} 必须是数组`);
  }
  return value as T[];
}

export function getOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${fieldName} 必须是数字`);
  }
  return value;
}
