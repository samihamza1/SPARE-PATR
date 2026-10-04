import {
  createAliasSchema,
  createBrandSchema,
  createCategorySchema,
  createVehicleSchema,
  idParamsSchema,
  normalizeSearchText,
  updateBrandSchema,
  updateCategorySchema,
  updateVehicleSchema,
} from '@autoparts/shared';
import type { Brand, Category, VehicleAlias } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { notFound } from '../../errors';
import type { Trx } from '../../catalog/mappers';
import { iso, likeContains, toVehicle } from '../../catalog/mappers';
import { actorOf, inTenant } from '../common';

const MANAGE = 'catalog.manage' as const;

async function loadBrands(trx: Trx, id?: string): Promise<Brand[]> {
  let q = trx.selectFrom('brands').select(['id', 'name', 'kind', 'archived_at']).orderBy('name');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind as Brand['kind'],
    archivedAt: iso(b.archived_at),
  }));
}

async function loadCategories(trx: Trx, id?: string): Promise<Category[]> {
  let q = trx
    .selectFrom('categories')
    .select(['id', 'parent_id', 'name_ar', 'name_en', 'archived_at'])
    .orderBy('name_en')
    .orderBy('name_ar');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((c) => ({
    id: c.id,
    parentId: c.parent_id,
    nameAr: c.name_ar,
    nameEn: c.name_en,
    archivedAt: iso(c.archived_at),
  }));
}

async function loadAliases(trx: Trx, id?: string): Promise<VehicleAlias[]> {
  let q = trx
    .selectFrom('vehicle_aliases')
    .select(['id', 'alias', 'target', 'vehicle_id', 'category_id'])
    .where('removed_at', 'is', null)
    .orderBy('alias');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((a) => ({
    id: a.id,
    alias: a.alias,
    target: a.target as VehicleAlias['target'],
    vehicleId: a.vehicle_id,
    categoryId: a.category_id,
  }));
}

export function taxonomyRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => deps.now();

  // --- brands ---
  r.get('/catalog/brands', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadBrands(trx)),
  );
  r.post(
    '/catalog/brands',
    { schema: { body: createBrandSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const brand = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        await trx
          .insertInto('brands')
          .values({ id: b.id, tenant_id: auth.tenantId, name: b.name, kind: b.kind })
          .execute();
        const [after] = await loadBrands(trx, b.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'brand.create', entityType: 'brand', entityId: b.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(brand);
    },
  );
  r.patch(
    '/catalog/brands/:id',
    { schema: { params: idParamsSchema, body: updateBrandSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const [before] = await loadBrands(trx, id);
        if (before === undefined) throw notFound();
        const b = request.body;
        await trx
          .updateTable('brands')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.kind !== undefined && { kind: b.kind }),
            ...(b.archived !== undefined && { archived_at: b.archived ? now() : null }),
          })
          .where('id', '=', id)
          .execute();
        const [after] = await loadBrands(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'brand.update', entityType: 'brand', entityId: id, before, after },
          now(),
        );
        return after;
      }),
  );

  // --- categories ---
  r.get('/catalog/categories', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadCategories(trx)),
  );
  r.post(
    '/catalog/categories',
    { schema: { body: createCategorySchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const category = await inTenant(deps, request, async (trx, auth) => {
        const c = request.body;
        await trx
          .insertInto('categories')
          .values({
            id: c.id,
            tenant_id: auth.tenantId,
            parent_id: c.parentId ?? null,
            name_ar: c.nameAr ?? null,
            name_en: c.nameEn ?? null,
          })
          .execute();
        const [after] = await loadCategories(trx, c.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'category.create', entityType: 'category', entityId: c.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(category);
    },
  );
  r.patch(
    '/catalog/categories/:id',
    { schema: { params: idParamsSchema, body: updateCategorySchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const [before] = await loadCategories(trx, id);
        if (before === undefined) throw notFound();
        const c = request.body;
        await trx
          .updateTable('categories')
          .set({
            ...(c.nameAr !== undefined && { name_ar: c.nameAr }),
            ...(c.nameEn !== undefined && { name_en: c.nameEn }),
            ...(c.parentId !== undefined && { parent_id: c.parentId }),
            ...(c.archived !== undefined && { archived_at: c.archived ? now() : null }),
          })
          .where('id', '=', id)
          .execute();
        const [after] = await loadCategories(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'category.update', entityType: 'category', entityId: id, before, after },
          now(),
        );
        return after;
      }),
  );

  // --- vehicles (platform rows are read-only here; tenants add local rows) ---
  r.get(
    '/catalog/vehicles',
    {
      schema: {
        querystring: z.object({ parentId: z.uuid().optional(), q: z.string().max(100).optional() }),
      },
      config: { access: 'authenticated' },
    },
    (request) =>
      inTenant(deps, request, async (trx) => {
        let q = trx
          .selectFrom('vehicles')
          .selectAll()
          .where('archived_at', 'is', null)
          .orderBy('name')
          .limit(500);
        const { parentId, q: text } = request.query;
        if (text !== undefined && text.trim() !== '') {
          q = q.where('search_text', 'like', likeContains(normalizeSearchText(text)));
        } else {
          q =
            parentId === undefined
              ? q.where('parent_id', 'is', null)
              : q.where('parent_id', '=', parentId);
        }
        return (await q.execute()).map(toVehicle);
      }),
  );
  r.post(
    '/catalog/vehicles',
    { schema: { body: createVehicleSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const vehicle = await inTenant(deps, request, async (trx, auth) => {
        const v = request.body;
        await trx
          .insertInto('vehicles')
          .values({
            id: v.id,
            tenant_id: auth.tenantId,
            parent_id: v.parentId,
            level: v.level,
            name: v.name,
            name_ar: v.nameAr ?? null,
            year_from: v.yearFrom ?? null,
            year_to: v.yearTo ?? null,
            engine_code: v.engineCode ?? null,
            displacement_cc: v.displacementCc ?? null,
            fuel: v.fuel ?? null,
          })
          .execute();
        const after = toVehicle(
          await trx
            .selectFrom('vehicles')
            .selectAll()
            .where('id', '=', v.id)
            .executeTakeFirstOrThrow(),
        );
        await audit(
          trx,
          actorOf(request),
          { action: 'vehicle.create', entityType: 'vehicle', entityId: v.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(vehicle);
    },
  );
  r.patch(
    '/catalog/vehicles/:id',
    { schema: { params: idParamsSchema, body: updateVehicleSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const row = await trx
          .selectFrom('vehicles')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        // Platform rows are visible but not editable by tenants.
        if (row?.tenant_id !== auth.tenantId) throw notFound();
        const before = toVehicle(row);
        const v = request.body;
        await trx
          .updateTable('vehicles')
          .set({
            ...(v.name !== undefined && { name: v.name }),
            ...(v.nameAr !== undefined && { name_ar: v.nameAr }),
            ...(v.yearFrom !== undefined && { year_from: v.yearFrom }),
            ...(v.yearTo !== undefined && { year_to: v.yearTo }),
            ...(v.engineCode !== undefined && { engine_code: v.engineCode }),
            ...(v.displacementCc !== undefined && { displacement_cc: v.displacementCc }),
            ...(v.fuel !== undefined && { fuel: v.fuel }),
            ...(v.archived !== undefined && { archived_at: v.archived ? now() : null }),
          })
          .where('id', '=', id)
          .execute();
        const after = toVehicle(
          await trx
            .selectFrom('vehicles')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow(),
        );
        await audit(
          trx,
          actorOf(request),
          { action: 'vehicle.update', entityType: 'vehicle', entityId: id, before, after },
          now(),
        );
        return after;
      }),
  );

  // --- aliases ---
  r.get('/catalog/vehicle-aliases', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadAliases(trx)),
  );
  r.post(
    '/catalog/vehicle-aliases',
    { schema: { body: createAliasSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const alias = await inTenant(deps, request, async (trx, auth) => {
        const a = request.body;
        await trx
          .insertInto('vehicle_aliases')
          .values({
            id: a.id,
            tenant_id: auth.tenantId,
            alias: a.alias,
            target: a.target,
            vehicle_id: a.vehicleId ?? null,
            category_id: a.categoryId ?? null,
          })
          .execute();
        const [after] = await loadAliases(trx, a.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'vehicle_alias.create', entityType: 'vehicle_alias', entityId: a.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(alias);
    },
  );
  r.post(
    '/catalog/vehicle-aliases/:id/remove',
    { schema: { params: idParamsSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      await inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const [before] = await loadAliases(trx, id);
        if (before === undefined) throw notFound();
        await trx
          .updateTable('vehicle_aliases')
          .set({ removed_at: now() })
          .where('id', '=', id)
          .execute();
        await audit(
          trx,
          actorOf(request),
          { action: 'vehicle_alias.remove', entityType: 'vehicle_alias', entityId: id, before },
          now(),
        );
      });
      return reply.code(204).send();
    },
  );
}
