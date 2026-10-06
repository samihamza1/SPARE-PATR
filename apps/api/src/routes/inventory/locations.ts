import {
  createLocationSchema,
  idParamsSchema,
  listLocationsQuerySchema,
  updateLocationSchema,
} from '@autoparts/shared';
import type { Location } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, notFound } from '../../errors';
import type { Trx } from '../common';
import { actorOf, inTenant, iso } from '../common';

const MANAGE = 'locations.manage' as const;

async function loadLocations(
  trx: Trx,
  opts: { id?: string; includeArchived?: boolean } = {},
): Promise<Location[]> {
  let q = trx
    .selectFrom('locations')
    .select(['id', 'name', 'kind', 'is_default', 'sort_order', 'archived_at'])
    .orderBy('sort_order')
    .orderBy('name');
  if (opts.id !== undefined) q = q.where('id', '=', opts.id);
  else if (opts.includeArchived !== true) q = q.where('archived_at', 'is', null);
  return (await q.execute()).map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind as Location['kind'],
    isDefault: l.is_default,
    sortOrder: l.sort_order,
    archivedAt: iso(l.archived_at),
  }));
}

async function loadLocation(trx: Trx, id: string): Promise<Location> {
  const [location] = await loadLocations(trx, { id });
  if (location === undefined) throw notFound();
  return location;
}

/**
 * Locations (ADR 0018): the shop and any storerooms or warehouses. Everyone signed in can
 * list them, because cashiers see quantities in every location (product owner, 2026-10-06).
 */
export function locationRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/locations',
    { schema: { querystring: listLocationsQuerySchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, (trx) =>
        loadLocations(trx, { includeArchived: request.query.includeArchived === true }),
      ),
  );

  r.post(
    '/locations',
    { schema: { body: createLocationSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const location = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        // The first location of a tenant becomes its default shop (it must be a shop).
        const hasDefault = await trx
          .selectFrom('locations')
          .select('id')
          .where('is_default', '=', true)
          .executeTakeFirst();
        if (hasDefault === undefined && b.kind !== 'shop') {
          throw new ApiError(409, 'location.not_a_shop');
        }
        await trx
          .insertInto('locations')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            name: b.name,
            kind: b.kind,
            is_default: hasDefault === undefined,
            sort_order: b.sortOrder ?? 0,
          })
          .execute();
        const created = await loadLocation(trx, b.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'location.create', entityType: 'location', entityId: b.id, after: created },
          deps.now(),
        );
        return created;
      });
      return reply.code(201).send(location);
    },
  );

  r.patch(
    '/locations/:id',
    { schema: { params: idParamsSchema, body: updateLocationSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const b = request.body;
        const before = await loadLocation(trx, id);
        if (b.isDefault === true && !before.isDefault) {
          if (before.kind !== 'shop') throw new ApiError(409, 'location.not_a_shop');
          if (before.archivedAt !== null) throw new ApiError(409, 'location.archived');
          // The partial unique index allows one default: demote the old one first.
          await trx
            .updateTable('locations')
            .set({ is_default: false })
            .where('is_default', '=', true)
            .execute();
          await trx
            .updateTable('locations')
            .set({ is_default: true })
            .where('id', '=', id)
            .execute();
        }
        if (b.archived === true && before.archivedAt === null) {
          // The database refuses stock (stock.has_stock) and devices; the default needs a
          // successor first.
          if (before.isDefault) throw new ApiError(409, 'location.archived');
          const devices = await trx
            .selectFrom('devices')
            .select('id')
            .where('location_id', '=', id)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
          if (devices !== undefined) throw new ApiError(409, 'location.has_devices');
        }
        const archivedAt =
          b.archived === undefined
            ? undefined
            : b.archived
              ? before.archivedAt === null
                ? deps.now()
                : undefined
              : null;
        if (b.name !== undefined || b.sortOrder !== undefined || archivedAt !== undefined) {
          await trx
            .updateTable('locations')
            .set({
              ...(b.name !== undefined && { name: b.name }),
              ...(b.sortOrder !== undefined && { sort_order: b.sortOrder }),
              ...(archivedAt !== undefined && { archived_at: archivedAt }),
            })
            .where('id', '=', id)
            .execute();
        }
        const after = await loadLocation(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'location.update', entityType: 'location', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );
}
