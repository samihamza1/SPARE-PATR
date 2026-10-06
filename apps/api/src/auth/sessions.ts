import { isIP } from 'node:net';
import { tenantSettingsSchema, toPermissions, uuidSchema } from '@autoparts/shared';
import type { DB } from '@autoparts/db';
import { withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type { Kysely, Transaction } from 'kysely';
import { randomSecret, safeEqual, sha256 } from '../security/crypto';
import type { AuthContext } from './context';

export const SESSION_COOKIE = 'sid';

/** Session limits from tenant settings; falls back to the schema defaults. */
export function sessionLimits(settings: unknown): { idleMinutes: number; absoluteHours: number } {
  const parsed = tenantSettingsSchema.shape.session.safeParse(
    (settings as { session?: unknown } | null)?.session ?? {},
  );
  return parsed.success ? parsed.data : tenantSettingsSchema.shape.session.parse({});
}

export function securityLimits(settings: unknown): {
  maxFailedLogins: number;
  lockoutMinutes: number;
} {
  const parsed = tenantSettingsSchema.shape.security.safeParse(
    (settings as { security?: unknown } | null)?.security ?? {},
  );
  return parsed.success ? parsed.data : tenantSettingsSchema.shape.security.parse({});
}

export interface ParsedToken {
  tenantId: string;
  sessionId: string;
  secret: string;
}

/** Cookie value: <tenant_id>.<session_id>.<secret>. The tenant id lets us set RLS context. */
export function parseSessionToken(token: string | undefined): ParsedToken | null {
  if (token === undefined) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tenantId = '', sessionId = '', secret = ''] = parts;
  if (!uuidSchema.safeParse(tenantId).success || !uuidSchema.safeParse(sessionId).success) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { tenantId, sessionId, secret };
}

export async function createSession(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    userId: string;
    deviceId: string | null;
    absoluteHours: number;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const sessionId = newId();
  const secret = randomSecret();
  const expiresAt = new Date(input.now.getTime() + input.absoluteHours * 3_600_000);
  await trx
    .insertInto('sessions')
    .values({
      id: sessionId,
      tenant_id: input.tenantId,
      user_id: input.userId,
      device_id: input.deviceId,
      secret_hash: sha256(secret),
      created_at: input.now,
      last_seen_at: input.now,
      expires_at: expiresAt,
      // sessions.ip is inet; behind a misconfigured proxy request.ip can be any string.
      ip: input.ip !== null && isIP(input.ip) !== 0 ? input.ip : null,
      user_agent: input.userAgent?.slice(0, 512) ?? null,
    })
    .execute();
  return { token: `${input.tenantId}.${sessionId}.${secret}`, sessionId, expiresAt };
}

/** Effective permissions: union over the user's active (non-revoked) roles. */
export async function loadPermissions(trx: Transaction<DB>, userId: string) {
  const rows = await trx
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'ur.tenant_id').onRef('r.id', '=', 'ur.role_id'),
    )
    .select('r.permissions')
    .where('ur.user_id', '=', userId)
    .where('ur.revoked_at', 'is', null)
    .where('r.archived_at', 'is', null)
    .execute();
  return new Set(toPermissions(rows.flatMap((r) => r.permissions)));
}

/** How stale last_seen_at may get before we write it again. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Validates a session token. Returns null for anything wrong: unknown, revoked, idle,
 * past its absolute limit, archived user, archived tenant, or a secret that does not match.
 */
export async function authenticate(
  db: Kysely<DB>,
  token: string | undefined,
  now: Date,
): Promise<AuthContext | null> {
  const parsed = parseSessionToken(token);
  if (parsed === null) return null;
  return withTenant(db, parsed.tenantId, async (trx) => {
    const row = await trx
      .selectFrom('sessions as s')
      .innerJoin('users as u', (j) =>
        j.onRef('u.tenant_id', '=', 's.tenant_id').onRef('u.id', '=', 's.user_id'),
      )
      .innerJoin('tenants as t', 't.id', 's.tenant_id')
      .select([
        's.id',
        's.user_id',
        's.device_id',
        's.secret_hash',
        's.last_seen_at',
        's.expires_at',
        's.revoked_at',
        'u.archived_at as user_archived_at',
        't.archived_at as tenant_archived_at',
        't.settings',
      ])
      .where('s.id', '=', parsed.sessionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (!safeEqual(row.secret_hash, sha256(parsed.secret))) return null;
    if (
      row.revoked_at !== null ||
      row.user_archived_at !== null ||
      row.tenant_archived_at !== null
    ) {
      return null;
    }
    const { idleMinutes } = sessionLimits(row.settings);
    if (now >= row.expires_at) return null;
    if (now.getTime() - row.last_seen_at.getTime() >= idleMinutes * 60_000) return null;

    if (now.getTime() - row.last_seen_at.getTime() >= TOUCH_INTERVAL_MS) {
      await trx
        .updateTable('sessions')
        .set({ last_seen_at: now })
        .where('id', '=', row.id)
        .execute();
    }
    return {
      tenantId: parsed.tenantId,
      userId: row.user_id,
      sessionId: row.id,
      deviceId: row.device_id,
      permissions: await loadPermissions(trx, row.user_id),
    };
  });
}

export async function revokeSessions(
  trx: Transaction<DB>,
  where: { userId?: string; deviceId?: string; sessionId?: string; exceptSessionId?: string },
  reason: string,
  now: Date,
): Promise<void> {
  let q = trx
    .updateTable('sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('revoked_at', 'is', null);
  if (where.userId !== undefined) q = q.where('user_id', '=', where.userId);
  if (where.deviceId !== undefined) q = q.where('device_id', '=', where.deviceId);
  if (where.sessionId !== undefined) q = q.where('id', '=', where.sessionId);
  if (where.exceptSessionId !== undefined) q = q.where('id', '!=', where.exceptSessionId);
  await q.execute();
}
