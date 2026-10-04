import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256, used for high-entropy secrets (session secrets, device codes and credentials). */
export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** 256 bits of randomness, URL-safe. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Crockford base32: no I, L, O, U, so codes are easy to read aloud and type.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 symbols = 50 bits. 256 is a multiple of 32, so `byte & 31` is unbiased. */
export function enrollmentCode(length = 10): string {
  return [...randomBytes(length)].map((b) => CROCKFORD[b & 31] ?? '').join('');
}

/** Accepts what people actually type: lower case, spaces, dashes, O for 0, I/L for 1. */
export function normalizeEnrollmentCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
