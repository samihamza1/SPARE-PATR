import type { DB } from '@autoparts/db';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import { securityLimits } from './sessions';

/** Keeps failed_login_count (an integer column) far from overflow under endless guessing. */
const MAX_COUNTED_FAILURES = 1_000_000;

export interface PasswordAttempt {
  /** The password was right and the account was not locked: the counter is cleared. */
  success: boolean;
  /** The account was already locked when the attempt arrived. */
  wasLocked: boolean;
  /** The account is locked after this attempt. */
  locked: boolean;
}

/**
 * Records one password check against the lockout (ADR 0017) in a single UPDATE, so
 * concurrent attempts cannot all read "unlocked" before one of them sets the lock.
 *
 * - Success (right password, not locked): counter to 0, lock cleared, last_login_at set.
 * - Anything else counts as a failure, including the right password while locked:
 *   counter + 1, and when it reaches security.maxFailedLogins, or the account was already
 *   locked, locked_until moves to now + security.lockoutMinutes.
 *
 * `verifiedHash` is the hash the password was checked against (outside the transaction,
 * so Argon2 never holds a pooled connection); if it changed meanwhile, the check is stale
 * and counts as a failure. Returns undefined when the user no longer exists or is archived.
 */
export async function recordPasswordAttempt(
  trx: Transaction<DB>,
  input: {
    userId: string;
    passwordOk: boolean;
    verifiedHash: string | null;
    settings: unknown;
    now: Date;
  },
): Promise<PasswordAttempt | undefined> {
  const { maxFailedLogins, lockoutMinutes } = securityLimits(input.settings);
  const lockUntil = new Date(input.now.getTime() + lockoutMinutes * 60_000);
  // The sub-select locks the row and reads its current state in the same statement.
  const { rows } = await sql<{ success: boolean; was_locked: boolean; locked_until: Date | null }>`
    UPDATE users AS u SET
      failed_login_count = CASE WHEN p.success THEN 0
        ELSE LEAST(u.failed_login_count, ${MAX_COUNTED_FAILURES}) + 1 END,
      locked_until = CASE
        WHEN p.success THEN NULL
        WHEN p.was_locked OR u.failed_login_count + 1 >= ${maxFailedLogins}
          THEN GREATEST(u.locked_until, ${lockUntil}::timestamptz)
        ELSE u.locked_until END,
      last_login_at = CASE WHEN p.success THEN ${input.now}::timestamptz ELSE u.last_login_at END
    FROM (
      SELECT
        id,
        coalesce(locked_until > ${input.now}::timestamptz, false) AS was_locked,
        coalesce(
          ${input.passwordOk}::boolean
            AND password_hash IS NOT DISTINCT FROM ${input.verifiedHash}::text
            AND NOT coalesce(locked_until > ${input.now}::timestamptz, false),
          false
        ) AS success
      FROM users
      WHERE id = ${input.userId} AND archived_at IS NULL
      FOR UPDATE
    ) AS p
    WHERE u.id = p.id
    RETURNING p.success, p.was_locked, u.locked_until`.execute(trx);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    success: row.success,
    wasLocked: row.was_locked,
    locked: row.locked_until !== null && row.locked_until > input.now,
  };
}
