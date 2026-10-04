import type { DB } from '@autoparts/db';
import { withTenant } from '@autoparts/db';
import type { MeResponse } from '@autoparts/shared';
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { AuditActor } from '../audit';
import type { AuthContext } from '../auth/context';
import type { PlatformDeps } from '../auth/plugin';
import { authOf } from '../auth/plugin';
import { ApiError } from '../errors';

export type Trx = Transaction<DB>;

/** Runs `fn` in the caller's tenant (SET LOCAL app.tenant_id), with the auth context. */
export function inTenant<T>(
  deps: PlatformDeps,
  request: FastifyRequest,
  fn: (trx: Trx, auth: AuthContext) => Promise<T>,
): Promise<T> {
  const auth = authOf(request);
  return withTenant(deps.db, auth.tenantId, (trx) => fn(trx, auth));
}

export function actorOf(request: FastifyRequest): AuditActor {
  const auth = authOf(request);
  return {
    tenantId: auth.tenantId,
    userId: auth.userId,
    deviceId: auth.deviceId,
    requestId: request.id,
  };
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Refuses a change that would leave no active user holding a role with both users.manage
 * and roles.manage; otherwise a tenant could lock itself out of administration.
 */
export async function assertAdminRemains(trx: Trx): Promise<void> {
  const row = await trx
    .selectFrom('users as u')
    .innerJoin('user_roles as ur', (j) =>
      j.onRef('ur.tenant_id', '=', 'u.tenant_id').onRef('ur.user_id', '=', 'u.id'),
    )
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'ur.tenant_id').onRef('r.id', '=', 'ur.role_id'),
    )
    .select('u.id')
    .where('u.archived_at', 'is', null)
    .where('ur.revoked_at', 'is', null)
    .where('r.archived_at', 'is', null)
    .where(sql<boolean>`r.permissions @> ARRAY['users.manage', 'roles.manage']::text[]`)
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) throw new ApiError(409, 'users.last_admin');
}

export async function loadMe(trx: Trx, auth: Pick<AuthContext, 'userId' | 'permissions'>) {
  const user = await trx
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'locale'])
    .where('id', '=', auth.userId)
    .executeTakeFirstOrThrow();
  const tenant = await trx
    .selectFrom('tenants')
    .select(['id', 'slug', 'name', 'default_locale', 'functional_currency'])
    .executeTakeFirstOrThrow();
  const me: MeResponse = {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      locale: user.locale,
    },
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      defaultLocale: tenant.default_locale,
      functionalCurrency: tenant.functional_currency,
    },
    permissions: [...auth.permissions].sort(),
  };
  return me;
}
