import type { DB } from '@autoparts/db';
import { withTenant } from '@autoparts/db';
import { changeOwnPasswordSchema, loginRequestSchema } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { audit } from '../audit';
import { recordPasswordAttempt } from '../auth/lockout';
import type { PlatformDeps } from '../auth/plugin';
import { authOf } from '../auth/plugin';
import {
  SESSION_COOKIE,
  createSession,
  loadPermissions,
  revokeSessions,
  sessionLimits,
} from '../auth/sessions';
import { ApiError } from '../errors';
import { safeEqual, sha256 } from '../security/crypto';
import { hashPassword, verifyPassword } from '../security/password';
import type { Trx } from './common';
import { actorOf, inTenant, loadMe } from './common';

const invalidCredentials = () => new ApiError(401, 'auth.invalid_credentials');

/** Per (IP, shop, username): slows guessing without letting one IP lock out a whole shop. */
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export async function resolveTenant(db: Kysely<DB>, slug: string): Promise<string | null> {
  const { rows } = await sql<{
    id: string | null;
  }>`SELECT resolve_tenant_slug(${slug}) AS id`.execute(db);
  return rows[0]?.id ?? null;
}

/** Optional X-Device-Credential header binds the session to an enrolled, active device. */
async function deviceFromCredential(
  trx: Trx,
  credential: string | undefined,
  now: Date,
): Promise<string | null> {
  if (credential === undefined || credential.length > 128) return null;
  const hash = sha256(credential);
  const device = await trx
    .selectFrom('devices')
    .select(['id', 'credential_hash'])
    .where('credential_hash', '=', hash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (device?.credential_hash == null || !safeEqual(device.credential_hash, hash)) return null;
  await trx.updateTable('devices').set({ last_seen_at: now }).where('id', '=', device.id).execute();
  return device.id;
}

export function setSessionCookie(
  reply: FastifyReply,
  deps: PlatformDeps,
  token: string,
  expires: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: deps.cookieSecure,
    expires,
  });
}

export function authRoutes(
  app: FastifyInstance,
  deps: PlatformDeps,
  credentialThrottle: preHandlerAsyncHookHandler,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/login',
    {
      schema: { body: loginRequestSchema },
      preHandler: credentialThrottle,
      config: {
        access: 'public',
        rateLimit: {
          ...LOGIN_RATE_LIMIT,
          hook: 'preHandler',
          keyGenerator: (req) => {
            const body = req.body as { tenant?: unknown; username?: unknown } | undefined;
            return `login|${req.ip}|${String(body?.tenant)}|${String(body?.username).toLowerCase()}`;
          },
        },
      },
    },
    async (request, reply) => {
      const { tenant, username, password } = request.body;
      const now = deps.now();
      const tenantId = await resolveTenant(deps.db, tenant);
      if (tenantId === null) {
        await verifyPassword(null, password);
        throw invalidCredentials();
      }

      const found = await withTenant(deps.db, tenantId, async (trx) => ({
        user: await trx
          .selectFrom('users')
          .select(['id', 'password_hash'])
          .where(sql<string>`lower(username)`, '=', username.toLowerCase())
          .where('archived_at', 'is', null)
          .executeTakeFirst(),
        settings: (await trx.selectFrom('tenants').select('settings').executeTakeFirstOrThrow())
          .settings,
      }));
      const { user, settings } = found;

      // Argon2 runs outside any transaction so no pooled connection waits on it. It runs
      // for every request, locked or not, so timing does not reveal the lock (ADR 0017).
      const verifiedHash = user?.password_hash ?? null;
      const passwordOk = await verifyPassword(verifiedHash, password);

      const result = await withTenant(deps.db, tenantId, async (trx) => {
        const failed = async (
          reason: string,
          userId: string | null,
          action = 'auth.login_failed',
        ) => {
          await audit(
            trx,
            { tenantId, userId: null, requestId: request.id },
            {
              action,
              entityType: 'user',
              entityId: userId,
              after: { username, reason, ip: request.ip },
            },
            now,
          );
          return null;
        };
        if (user === undefined) return failed('unknown_user', null);
        // One atomic decision; while locked, the right password fails like a wrong one.
        const outcome = await recordPasswordAttempt(trx, {
          userId: user.id,
          passwordOk,
          verifiedHash,
          settings,
          now,
        });
        if (outcome === undefined) return failed('unknown_user', null);
        if (!outcome.success) {
          if (outcome.wasLocked) return failed('locked', user.id);
          return failed('bad_password', user.id, outcome.locked ? 'auth.lockout' : undefined);
        }

        const deviceId = await deviceFromCredential(
          trx,
          request.headers['x-device-credential'] as string | undefined,
          now,
        );
        const { absoluteHours } = sessionLimits(settings);
        const session = await createSession(trx, {
          tenantId,
          userId: user.id,
          deviceId,
          absoluteHours,
          now,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        await audit(
          trx,
          { tenantId, userId: user.id, deviceId, requestId: request.id },
          { action: 'auth.login', entityType: 'session', entityId: session.sessionId },
          now,
        );
        const permissions = await loadPermissions(trx, user.id);
        return { session, me: await loadMe(trx, { userId: user.id, permissions }) };
      });
      if (result === null) throw invalidCredentials();

      setSessionCookie(reply, deps, result.session.token, result.session.expiresAt);
      return result.me;
    },
  );

  r.post('/auth/logout', { config: { access: 'authenticated' } }, async (request, reply) => {
    const now = deps.now();
    await inTenant(deps, request, async (trx, auth) => {
      await revokeSessions(trx, { sessionId: auth.sessionId }, 'logout', now);
      await audit(
        trx,
        actorOf(request),
        { action: 'auth.logout', entityType: 'session', entityId: auth.sessionId },
        now,
      );
    });
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  r.get('/auth/me', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx, auth) => loadMe(trx, auth)),
  );

  r.post(
    '/me/password',
    { schema: { body: changeOwnPasswordSchema }, config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = authOf(request);
      const now = deps.now();
      const current = await inTenant(deps, request, (trx) =>
        trx
          .selectFrom('users')
          .select('password_hash')
          .where('id', '=', auth.userId)
          .executeTakeFirstOrThrow(),
      );
      if (!(await verifyPassword(current.password_hash, request.body.currentPassword))) {
        throw new ApiError(400, 'auth.wrong_password');
      }
      const hash = await hashPassword(request.body.newPassword);
      await inTenant(deps, request, async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: hash, password_changed_at: now })
          .where('id', '=', auth.userId)
          .execute();
        await revokeSessions(
          trx,
          { userId: auth.userId, exceptSessionId: auth.sessionId },
          'password_changed',
          now,
        );
        await audit(
          trx,
          actorOf(request),
          { action: 'user.password_change', entityType: 'user', entityId: auth.userId },
          now,
        );
      });
      return reply.code(204).send();
    },
  );
}
