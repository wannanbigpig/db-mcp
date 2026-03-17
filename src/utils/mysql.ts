import { assertString } from './validation.js';

const MYSQL_IDENTIFIER_PATTERN = /^[A-Za-z0-9_$]+$/;

function validateIdentifier(identifier: string, fieldName: string): string {
  const normalized = assertString(identifier, fieldName);
  if (!MYSQL_IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} 包含非法字符，仅允许字母、数字、下划线和 $`);
  }
  return normalized;
}

export function escapeIdentifier(identifier: string, fieldName: string): string {
  const normalized = validateIdentifier(identifier, fieldName);
  return `\`${normalized.replace(/`/g, '``')}\``;
}

export function buildAssignments(data: Record<string, unknown>, fieldName: string): {
  clause: string;
  values: unknown[];
} {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error(`${fieldName} 不能为空对象`);
  }

  return {
    clause: keys.map((key) => `${escapeIdentifier(key, `${fieldName}.${key}`)} = ?`).join(', '),
    values: keys.map((key) => data[key]),
  };
}

export function buildInsert(data: Record<string, unknown>, fieldName: string): {
  columns: string;
  placeholders: string;
  values: unknown[];
} {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error(`${fieldName} 不能为空对象`);
  }

  return {
    columns: keys.map((key) => escapeIdentifier(key, `${fieldName}.${key}`)).join(', '),
    placeholders: keys.map(() => '?').join(', '),
    values: keys.map((key) => data[key]),
  };
}

export function buildWhereClause(where: Record<string, unknown>, fieldName: string): {
  clause: string;
  values: unknown[];
} {
  const keys = Object.keys(where);
  if (keys.length === 0) {
    throw new Error(`${fieldName} 不能为空对象`);
  }

  return {
    clause: keys.map((key) => `${escapeIdentifier(key, `${fieldName}.${key}`)} = ?`).join(' AND '),
    values: keys.map((key) => where[key]),
  };
}
