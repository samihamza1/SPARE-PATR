import { hash, verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';
import { randomSecret } from './crypto';

/**
 * Argon2id (the library default algorithm) with the OWASP baseline: m = 19 MiB, t = 2, p = 1.
 * See ADR 0007; a unit test pins the encoded parameters.
 */
const ARGON2_OPTIONS: Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. With no stored hash (unknown user, no password set) it still runs a
 * full verification against a dummy hash so the response time does not reveal which case
 * it was.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (stored === null) {
    dummyHash ??= hashPassword(randomSecret());
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
