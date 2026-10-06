import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The SHA-256 of a document request (invariant 5: sync endpoints are idempotent). A retry
 * with the same document id must send the same request; otherwise it is a conflict.
 */
export function requestHash(request: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(request)).digest();
}
