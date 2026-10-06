import {
  createRoleSchema,
  idParamsSchema,
  toPermissions,
  updateRoleSchema,
} from '@autoparts/shared';
import type { Role } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import type { PlatformDeps } from '../auth/plugin';
import { notFound } from '../errors';
import type { Trx } from './common';
import { actorOf, assertAdminRemains, inTenant, lockAdminChanges, privilegeGuard } from './common';

async function loadRoles(trx: Trx, id?: string): Promise<Role[]> {
  let q = trx
    .selectFrom('roles')
    .select(['id', 'code', 'name', 'is_system', 'permissions'])
    .where('archived_at', 'is', null)
    .orderBy('is_system', 'desc')
    .orderBy('code');
  if (id !== undefined) q = q.where('id', '=', id);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.is_system,
    permissions: toPermissions(r.permissions),
  }));
}

export function roleRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const access = 'roles.manage' as const;

  // Any signed-in user may list roles (the UI needs names); changing them needs roles.manage.
  r.get('/roles', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadRoles(trx)),
  );

  r.post(
    '/roles',
    { schema: { body: createRoleSchema }, config: { access } },
    async (request, reply) => {
      const role = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        await lockAdminChanges(trx, auth.tenantId);
        (await privilegeGuard(trx, auth)).permissions(b.permissions);
        await trx
          .insertInto('roles')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            code: b.code,
            name: b.name,
            permissions: toPermissions(b.permissions),
          })
          .execute();
        const [created] = await loadRoles(trx, b.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'role.create', entityType: 'role', entityId: b.id, after: created },
          deps.now(),
        );
        return created;
      });
      return reply.code(201).send(role);
    },
  );

  r.patch(
    '/roles/:id',
    { schema: { params: idParamsSchema, body: updateRoleSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        await lockAdminChanges(trx, auth.tenantId);
        const [before] = await loadRoles(trx, id);
        if (before === undefined) throw notFound();
        const b = request.body;
        // Only roles within the actor's own permissions, and only to such a set.
        const guard = await privilegeGuard(trx, auth);
        await guard.role(id);
        if (b.permissions !== undefined) guard.permissions(b.permissions);
        await trx
          .updateTable('roles')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.permissions !== undefined && { permissions: toPermissions(b.permissions) }),
          })
          .where('id', '=', id)
          .execute();
        await assertAdminRemains(trx);
        const [after] = await loadRoles(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'role.update', entityType: 'role', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );
}
