import {
  createUserSchema,
  grantRoleSchema,
  idParamsSchema,
  newId,
  resetPasswordSchema,
  updateUserSchema,
  uuidSchema,
} from '@autoparts/shared';
import type { User } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import type { PlatformDeps } from '../auth/plugin';
import { revokeSessions } from '../auth/sessions';
import { ApiError, notFound } from '../errors';
import { hashPassword } from '../security/password';
import type { Trx } from './common';
import {
  actorOf,
  assertAdminRemains,
  inTenant,
  iso,
  lockAdminChanges,
  privilegeGuard,
} from './common';

const USER_COLUMNS = [
  'id',
  'username',
  'display_name',
  'email',
  'locale',
  'archived_at',
  'last_login_at',
] as const;

async function loadUsers(trx: Trx, id?: string): Promise<User[]> {
  let q = trx.selectFrom('users').select(USER_COLUMNS).orderBy('username');
  if (id !== undefined) q = q.where('id', '=', id);
  const users = await q.execute();
  let g = trx
    .selectFrom('user_roles')
    .select(['user_id', 'role_id'])
    .where('revoked_at', 'is', null);
  if (id !== undefined) g = g.where('user_id', '=', id);
  const grants = await g.execute();
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    locale: u.locale,
    archivedAt: iso(u.archived_at),
    lastLoginAt: iso(u.last_login_at),
    roleIds: grants.filter((x) => x.user_id === u.id).map((x) => x.role_id),
  }));
}

async function loadUser(trx: Trx, id: string): Promise<User> {
  const [user] = await loadUsers(trx, id);
  if (user === undefined) throw notFound();
  return user;
}

export function userRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const access = 'users.manage' as const;

  r.get('/users', { config: { access } }, (request) =>
    inTenant(deps, request, (trx) => loadUsers(trx)),
  );

  r.post(
    '/users',
    { schema: { body: createUserSchema }, config: { access } },
    async (request, reply) => {
      const { password, ...input } = request.body;
      const hash = await hashPassword(password);
      const now = deps.now();
      const user = await inTenant(deps, request, async (trx, auth) => {
        await trx
          .insertInto('users')
          .values({
            id: input.id,
            tenant_id: auth.tenantId,
            username: input.username,
            display_name: input.displayName,
            email: input.email ?? null,
            locale: input.locale ?? null,
            password_hash: hash,
            password_changed_at: now,
          })
          .execute();
        const created = await loadUser(trx, input.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'user.create', entityType: 'user', entityId: input.id, after: created },
          now,
        );
        return created;
      });
      return reply.code(201).send(user);
    },
  );

  r.patch(
    '/users/:id',
    { schema: { params: idParamsSchema, body: updateUserSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        await lockAdminChanges(trx, auth.tenantId);
        const before = await loadUser(trx, id);
        await (await privilegeGuard(trx, auth)).user(id);
        const b = request.body;
        await trx
          .updateTable('users')
          .set({
            ...(b.displayName !== undefined && { display_name: b.displayName }),
            ...(b.email !== undefined && { email: b.email }),
            ...(b.locale !== undefined && { locale: b.locale }),
          })
          .where('id', '=', id)
          .execute();
        const after = await loadUser(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'user.update', entityType: 'user', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );

  r.post(
    '/users/:id/archive',
    { schema: { params: idParamsSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        // Archiving yourself would end your own session mid-request; ask another admin.
        if (id === auth.userId) throw new ApiError(409, 'resource.conflict');
        const now = deps.now();
        await lockAdminChanges(trx, auth.tenantId);
        const before = await loadUser(trx, id);
        await (await privilegeGuard(trx, auth)).user(id);
        if (before.archivedAt !== null) return before;
        await trx.updateTable('users').set({ archived_at: now }).where('id', '=', id).execute();
        await revokeSessions(trx, { userId: id }, 'user_archived', now);
        await assertAdminRemains(trx);
        const after = await loadUser(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'user.archive', entityType: 'user', entityId: id, before, after },
          now,
        );
        return after;
      }),
  );

  r.post(
    '/users/:id/password',
    { schema: { params: idParamsSchema, body: resetPasswordSchema }, config: { access } },
    async (request, reply) => {
      const hash = await hashPassword(request.body.password);
      const now = deps.now();
      await inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        await lockAdminChanges(trx, auth.tenantId);
        await loadUser(trx, id);
        // Setting the password of someone with more permissions would be a takeover.
        await (await privilegeGuard(trx, auth)).user(id);
        await trx
          .updateTable('users')
          .set({
            password_hash: hash,
            password_changed_at: now,
            failed_login_count: 0,
            locked_until: null,
          })
          .where('id', '=', id)
          .execute();
        await revokeSessions(trx, { userId: id }, 'password_reset', now);
        await audit(
          trx,
          actorOf(request),
          { action: 'user.password_reset', entityType: 'user', entityId: id },
          now,
        );
      });
      return reply.code(204).send();
    },
  );

  r.post(
    '/users/:id/roles',
    { schema: { params: idParamsSchema, body: grantRoleSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const { roleId } = request.body;
        const now = deps.now();
        await lockAdminChanges(trx, auth.tenantId);
        const before = await loadUser(trx, id);
        if (before.archivedAt !== null) throw notFound();
        const guard = await privilegeGuard(trx, auth);
        await guard.user(id);
        await guard.role(roleId);
        const grantId = newId();
        await trx
          .insertInto('user_roles')
          .values({
            id: grantId,
            tenant_id: auth.tenantId,
            user_id: id,
            role_id: roleId,
            granted_at: now,
            granted_by: auth.userId,
          })
          .execute();
        const after = await loadUser(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'role.grant', entityType: 'user', entityId: id, before, after },
          now,
        );
        return after;
      }),
  );

  r.post(
    '/users/:id/roles/:roleId/revoke',
    {
      schema: { params: z.object({ id: uuidSchema, roleId: uuidSchema }) },
      config: { access },
    },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id, roleId } = request.params;
        const now = deps.now();
        await lockAdminChanges(trx, auth.tenantId);
        const before = await loadUser(trx, id);
        const guard = await privilegeGuard(trx, auth);
        await guard.user(id);
        await guard.role(roleId);
        const result = await trx
          .updateTable('user_roles')
          .set({ revoked_at: now, revoked_by: auth.userId })
          .where('user_id', '=', id)
          .where('role_id', '=', roleId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) throw notFound();
        await assertAdminRemains(trx);
        const after = await loadUser(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'role.revoke', entityType: 'user', entityId: id, before, after },
          now,
        );
        return after;
      }),
  );
}
