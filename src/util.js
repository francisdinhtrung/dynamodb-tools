import { unmarshall } from '@aws-sdk/util-dynamodb';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseLimit(raw, { def = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit must be a positive integer, got "${raw}"`);
  return Math.min(n, max);
}

// Pagination token: base64url(JSON(marshalled LastEvaluatedKey)). Binary values are tagged so they survive JSON.
export function encodeToken(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  const json = JSON.stringify(lastEvaluatedKey, (_k, v) =>
    v instanceof Uint8Array ? { __b64: Buffer.from(v).toString('base64') } : v,
  );
  return Buffer.from(json).toString('base64url');
}

export function decodeToken(token) {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'), (_k, v) =>
      v && typeof v === 'object' && typeof v.__b64 === 'string' ? new Uint8Array(Buffer.from(v.__b64, 'base64')) : v,
    );
  } catch {
    throw new UsageError('Invalid --next-token');
  }
}

// Convert a DynamoDB item into plain JSON-safe values (Sets -> arrays, binary -> {$binary}, big numbers -> string).
export function toPlain(item) {
  return normalize(unmarshall(item, { wrapNumbers: true }));
}

function normalize(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Set) return [...v].map(normalize);
  if (v instanceof Uint8Array) return { $binary: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object' && 'value' in v && Object.keys(v).length === 1 && v.constructor?.name === 'NumberValue') {
    const n = Number(v.value);
    return Number.isSafeInteger(n) || (!Number.isInteger(n) && String(n) === v.value) ? n : v.value;
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

// Replace values of the given attribute names (at any depth) with "[REDACTED]".
export function redact(value, fields) {
  if (!fields?.size) return value;
  if (Array.isArray(value)) return value.map((x) => redact(x, fields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fields.has(k) ? '[REDACTED]' : redact(v, fields)]),
    );
  }
  return value;
}

export function parseList(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// DDB_ALLOWED_TABLES="orders,users-*" -> exact names or prefix match with trailing "*". Empty = allow all.
export function assertTableAllowed(table, allowedRaw = process.env.DDB_ALLOWED_TABLES) {
  const allowed = parseList(allowedRaw);
  if (!allowed.length) return;
  const ok = allowed.some((p) => (p.endsWith('*') ? table.startsWith(p.slice(0, -1)) : table === p));
  if (!ok) throw new UsageError(`Table "${table}" is not in DDB_ALLOWED_TABLES`);
}

export function isTableAllowed(table, allowedRaw = process.env.DDB_ALLOWED_TABLES) {
  try {
    assertTableAllowed(table, allowedRaw);
    return true;
  } catch {
    return false;
  }
}

// Build an AttributeValue for a key attribute given its declared type (S | N | B).
export function keyValue(raw, type, attrName) {
  if (type === 'N') {
    if (raw.trim() === '' || Number.isNaN(Number(raw))) throw new UsageError(`Key "${attrName}" is a number, got "${raw}"`);
    return { N: raw };
  }
  if (type === 'B') return { B: new Uint8Array(Buffer.from(raw, 'base64')) };
  return { S: raw };
}

export function projection(fields) {
  if (!fields.length) return {};
  const names = {};
  const expr = fields.map((f, i) => {
    names[`#p${i}`] = f;
    return `#p${i}`;
  });
  return { ProjectionExpression: expr.join(', '), ExpressionAttributeNames: names };
}

// Infer attribute names/types/frequency from a set of raw (marshalled) items.
export function inferShape(rawItems) {
  const shape = {};
  for (const item of rawItems) {
    for (const [name, av] of Object.entries(item)) {
      const type = Object.keys(av)[0];
      shape[name] ??= { types: [], present: 0 };
      shape[name].present++;
      if (!shape[name].types.includes(type)) shape[name].types.push(type);
    }
  }
  return shape;
}
