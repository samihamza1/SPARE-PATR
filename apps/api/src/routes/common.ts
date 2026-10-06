import type { DB } from '@autoparts/db';
import { withTenant } from '@autoparts/db';
import { toPermissions } from '@autoparts/shared';
import type { MeResponse, Permission } from '@autoparts/shared';
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { AuditActor } from '../audit';
import type { AuthContext } from '../auth/context';
import type { PlatformDeps } from '../auth/plugin';
import { authOf } from '../auth/plugin';
import { loadPermissions } from '../auth/sessions';
import { ApiError, notFound } from '../errors';

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

/** Advisory-lock namespace (first key) for changes to who administers a tenant. */
const ADMIN_CHANGES_LOCK = 1_094_995_278;

/**
 * Serialises, per tenant, every change to roles, user roles, passwords set by an admin
 * and archiving (ADR 0017). Take it first, before any check reads permissions or admins:
 * otherwise two concurrent changes can each pass assertAdminRemains while the other is
 * still uncommitted, and together leave no administrator. Released at commit/rollback.
 */
export async function lockAdminChanges(trx: Trx, tenantId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${ADMIN_CHANGES_LOCK}::int, hashtext(${tenantId}::text))`.execute(
    trx,
  );
}

const exceedsOwnPermissions = () => new ApiError(403, 'auth.exceeds_own_permissions');

/**
 * No privilege escalation (ADR 0017): an actor may only grant, remove or define
 * permissions it holds itself, and only act on users whose permissions it holds. The
 * actor's permissions are re-read here, in the transaction, after lockAdminChanges.
 */
export async function privilegeGuard(trx: Trx, auth: AuthContext) {
  const own = await loadPermissions(trx, auth.userId);
  const assertHeld = (permissions: Iterable<Permission>): void => {
    for (const p of permissions) if (!own.has(p)) throw exceedsOwnPermissions();
  };
  return {
    /** Every permission in the set must be one the actor holds. */
    permissions: assertHeld,
    /** The user's effective permissions must all be held by the actor. */
    user: async (userId: string): Promise<void> => {
      assertHeld(await loadPermissions(trx, userId));
    },
    /** The role's permissions must all be held by the actor; 404 if there is no such role. */
    role: async (roleId: string): Promise<void> => {
      const role = await trx
        .selectFrom('roles')
        .select('permissions')
        .where('id', '=', roleId)
        .executeTakeFirst();
      if (role === undefined) throw notFound();
      assertHeld(toPermissions(role.permissions));
    },
  };
}

/**
 * Refuses a change that would leave no active user holding a role with both users.manage
 * and roles.manage; otherwise a tenant could lock itself out of administration. Call it
 * only after lockAdminChanges.
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
