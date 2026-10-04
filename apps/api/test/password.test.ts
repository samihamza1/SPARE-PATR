import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/security/password';
import { enrollmentCode, normalizeEnrollmentCode } from '../src/security/crypto';
import { parseSessionToken } from '../src/auth/sessions';

describe('password hashing', () => {
  it('uses Argon2id with the OWASP baseline parameters (ADR 0007)', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('returns false (after doing the work) when there is no stored hash', async () => {
    expect(await verifyPassword(null, 'anything')).toBe(false);
  });

  it('treats a corrupt stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('enrollment codes', () => {
  it('are 10 Crockford base32 symbols', () => {
    for (let i = 0; i < 100; i++) expect(enrollmentCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it('normalise what people type', () => {
    expect(normalizeEnrollmentCode('abc1o-xyz il')).toBe('ABC10XYZ11');
  });
});

describe('session tokens', () => {
  const tenant = '0190f8e2-7c5a-7b4e-9a1d-2f3e4d5c6b7a';
  const session = '0190f8e2-7c5a-7b4e-9a1d-2f3e4d5c6b7b';
  const secret = 'a'.repeat(43);

  it('parse <tenant>.<session>.<secret>', () => {
    expect(parseSessionToken(`${tenant}.${session}.${secret}`)).toEqual({
      tenantId: tenant,
      sessionId: session,
      secret,
    });
  });

  it.each([
    undefined,
    '',
    'x.y.z',
    `${tenant}.${session}`,
    `${tenant}.${session}.short`,
    `${tenant}.${session}.${secret}.extra`,
  ])('reject %j', (token) => {
    expect(parseSessionToken(token)).toBeNull();
  });
});
