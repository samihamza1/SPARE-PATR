import {
  addFitmentSchema,
  addPartNumberSchema,
  bulkUpdatePartsSchema,
  createPartSchema,
  idParamsSchema,
  linkInterchangeSchema,
  listPartsQuerySchema,
  newId,
  normalizePartNumber,
  normalizeSearchText,
  supersedeSchema,
  updatePartSchema,
  uuidSchema,
} from '@autoparts/shared';
import type { PartDetail } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { conflict, notFound } from '../../errors';
import type { Trx } from '../../catalog/mappers';
import {
  PART_COLUMNS,
  currentPrices,
  defaultPriceList,
  likeContains,
  likePrefix,
  toPartSummary,
  vehiclePaths,
} from '../../catalog/mappers';
import { actorOf, inTenant } from '../common';

const MANAGE = 'catalog.manage' as const;

export async function loadPartDetail(trx: Trx, id: string, now: Date): Promise<PartDetail> {
  const part = await trx
    .selectFrom('parts')
    .select([...PART_COLUMNS, 'notes'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (part === undefined) throw notFound();

  const numbers = await trx
    .selectFrom('part_numbers')
    .select(['id', 'number', 'number_norm', 'kind', 'brand_id'])
    .where('part_id', '=', id)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .execute();
  const fitments = await trx
    .selectFrom('fitments')
    .select(['id', 'vehicle_id', 'note'])
    .where('part_id', '=', id)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .execute();
  const paths = await vehiclePaths(
    trx,
    fitments.map((f) => f.vehicle_id),
  );

  const interchange = await trx
    .selectFrom('interchange_members as m1')
    .innerJoin('interchange_members as m2', (j) =>
      j.onRef('m2.tenant_id', '=', 'm1.tenant_id').onRef('m2.group_id', '=', 'm1.group_id'),
    )
    .innerJoin('parts as p', 'p.id', 'm2.part_id')
    .select(PART_COLUMNS.map((c) => `p.${c}` as const))
    .where('m1.part_id', '=', id)
    .where('m1.removed_at', 'is', null)
    .where('m2.removed_at', 'is', null)
    .where('m2.part_id', '!=', id)
    .orderBy('p.sku')
    .execute();
  const supersededBy = await trx
    .selectFrom('supersessions as s')
    .innerJoin('parts as p', 'p.id', 's.new_part_id')
    .select(PART_COLUMNS.map((c) => `p.${c}` as const))
    .where('s.old_part_id', '=', id)
    .where('s.removed_at', 'is', null)
    .executeTakeFirst();
  const supersedes = await trx
    .selectFrom('supersessions as s')
    .innerJoin('parts as p', 'p.id', 's.old_part_id')
    .select(PART_COLUMNS.map((c) => `p.${c}` as const))
    .where('s.new_part_id', '=', id)
    .where('s.removed_at', 'is', null)
    .execute();

  const lists = await trx
    .selectFrom('price_lists')
    .select(['id', 'currency'])
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  const prices = await Promise.all(
    lists.map(async (l) => {
      const amount = (await currentPrices(trx, l.id, [id], now)).get(id);
      return {
        priceListId: l.id,
        current: amount === undefined ? null : { amount, currency: l.currency },
      };
    }),
  );

  return {
    ...toPartSummary(part),
    notes: part.notes,
    numbers: numbers.map((n) => ({
      id: n.id,
      number: n.number,
      numberNorm: n.number_norm ?? '',
      kind: n.kind as 'oem',
      brandId: n.brand_id,
    })),
    fitments: fitments.map((f) => ({
      id: f.id,
      vehicleId: f.vehicle_id,
      path: paths.get(f.vehicle_id) ?? [],
      note: f.note,
    })),
    interchange: interchange.map(toPartSummary),
    supersededBy: supersededBy === undefined ? null : toPartSummary(supersededBy),
    supersedes: supersedes.map(toPartSummary),
    prices,
  };
}

export function partRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => deps.now();
  const subParams = z.object({ id: uuidSchema, linkId: uuidSchema });

  r.get(
    '/catalog/parts',
    { schema: { querystring: listPartsQuerySchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const f = request.query;
        let q = trx.selectFrom('parts as p').select(PART_COLUMNS.map((c) => `p.${c}` as const));
        if (f.includeArchived !== true) q = q.where('p.archived_at', 'is', null);
        if (f.brandId !== undefined) q = q.where('p.brand_id', '=', f.brandId);
        if (f.categoryId !== undefined) q = q.where('p.category_id', '=', f.categoryId);
        if (f.q !== undefined && f.q.trim() !== '') {
          const words = normalizeSearchText(f.q)
            .split(' ')
            .filter((w) => w !== '');
          const pn = normalizePartNumber(f.q);
          q = q.where((eb) =>
            eb.or([
              eb.and(words.map((w) => eb('p.search_text', 'like', likeContains(w)))),
              eb.exists(
                eb
                  .selectFrom('part_numbers as n')
                  .select(sql`1`.as('one'))
                  .whereRef('n.part_id', '=', 'p.id')
                  .where('n.removed_at', 'is', null)
                  .where('n.number_norm', 'like', likePrefix(pn)),
              ),
            ]),
          );
        }
        if (f.needsReview === 'ungraded') q = q.where('p.quality_grade', 'is', null);
        if (f.needsReview === 'no_fitment') {
          q = q.where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('fitments as x')
                  .select(sql`1`.as('one'))
                  .whereRef('x.part_id', '=', 'p.id')
                  .where('x.removed_at', 'is', null),
              ),
            ),
          );
        }
        if (f.needsReview === 'no_price') {
          const tenant = await trx
            .selectFrom('tenants')
            .select('functional_currency')
            .executeTakeFirstOrThrow();
          const list = await defaultPriceList(trx, tenant.functional_currency);
          if (list !== undefined) {
            q = q.where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('part_prices as pp')
                    .select(sql`1`.as('one'))
                    .whereRef('pp.part_id', '=', 'p.id')
                    .where('pp.price_list_id', '=', list.id),
                ),
              ),
            );
          }
        }
        if (f.after !== undefined) q = q.where(sql`upper(p.sku)`, '>', f.after.toUpperCase());
        const rows = await q
          .orderBy(sql`upper(p.sku)`)
          .limit(f.limit)
          .execute();
        return rows.map(toPartSummary);
      }),
  );

  r.get(
    '/catalog/parts/:id',
    { schema: { params: idParamsSchema }, config: { access: 'authenticated' } },
    (request) => inTenant(deps, request, (trx) => loadPartDetail(trx, request.params.id, now())),
  );

  r.post(
    '/catalog/parts',
    { schema: { body: createPartSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const part = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        await trx
          .insertInto('parts')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            sku: b.sku,
            name_ar: b.nameAr ?? null,
            name_en: b.nameEn ?? null,
            quality_grade: b.qualityGrade ?? null,
            brand_id: b.brandId ?? null,
            category_id: b.categoryId ?? null,
            notes: b.notes ?? null,
            ...(b.unit !== undefined && { unit: b.unit }),
          })
          .execute();
        for (const n of b.numbers ?? []) {
          await trx
            .insertInto('part_numbers')
            .values({
              id: n.id,
              tenant_id: auth.tenantId,
              part_id: b.id,
              number: n.number,
              kind: n.kind,
              brand_id: n.brandId ?? null,
            })
            .execute();
        }
        const after = await loadPartDetail(trx, b.id, now());
        await audit(
          trx,
          actorOf(request),
          { action: 'part.create', entityType: 'part', entityId: b.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(part);
    },
  );

  r.patch(
    '/catalog/parts/:id',
    { schema: { params: idParamsSchema, body: updatePartSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const before = await loadPartDetail(trx, id, now());
        const b = request.body;
        await trx
          .updateTable('parts')
          .set({
            ...(b.sku !== undefined && { sku: b.sku }),
            ...(b.nameAr !== undefined && { name_ar: b.nameAr }),
            ...(b.nameEn !== undefined && { name_en: b.nameEn }),
            ...(b.qualityGrade !== undefined && { quality_grade: b.qualityGrade }),
            ...(b.brandId !== undefined && { brand_id: b.brandId }),
            ...(b.categoryId !== undefined && { category_id: b.categoryId }),
            ...(b.unit !== undefined && { unit: b.unit }),
            ...(b.notes !== undefined && { notes: b.notes }),
            ...(b.archived !== undefined && { archived_at: b.archived ? now() : null }),
          })
          .where('id', '=', id)
          .execute();
        const after = await loadPartDetail(trx, id, now());
        await audit(
          trx,
          actorOf(request),
          { action: 'part.update', entityType: 'part', entityId: id, before, after },
          now(),
        );
        return after;
      }),
  );

  r.post(
    '/catalog/parts/bulk-update',
    { schema: { body: bulkUpdatePartsSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { ids, set } = request.body;
        const result = await trx
          .updateTable('parts')
          .set({
            ...(set.qualityGrade !== undefined && { quality_grade: set.qualityGrade }),
            ...(set.brandId !== undefined && { brand_id: set.brandId }),
            ...(set.categoryId !== undefined && { category_id: set.categoryId }),
          })
          .where('id', 'in', ids)
          .executeTakeFirst();
        await audit(
          trx,
          actorOf(request),
          { action: 'part.bulk_update', entityType: 'part', after: { ids, set } },
          now(),
        );
        return { updated: Number(result.numUpdatedRows) };
      }),
  );

  // --- numbers ---
  r.post(
    '/catalog/parts/:id/numbers',
    { schema: { params: idParamsSchema, body: addPartNumberSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const n = request.body;
        await trx
          .insertInto('part_numbers')
          .values({
            id: n.id,
            tenant_id: auth.tenantId,
            part_id: id,
            number: n.number,
            kind: n.kind,
            brand_id: n.brandId ?? null,
          })
          .execute();
        await audit(
          trx,
          actorOf(request),
          { action: 'part_number.add', entityType: 'part', entityId: id, after: n },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );
  r.post(
    '/catalog/parts/:id/numbers/:linkId/remove',
    { schema: { params: subParams }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id, linkId } = request.params;
        const res = await trx
          .updateTable('part_numbers')
          .set({ removed_at: now() })
          .where('id', '=', linkId)
          .where('part_id', '=', id)
          .where('removed_at', 'is', null)
          .returning(['number', 'kind'])
          .executeTakeFirst();
        if (res === undefined) throw notFound();
        await audit(
          trx,
          actorOf(request),
          { action: 'part_number.remove', entityType: 'part', entityId: id, before: res },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );

  // --- fitments ---
  r.post(
    '/catalog/parts/:id/fitments',
    { schema: { params: idParamsSchema, body: addFitmentSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const f = request.body;
        await trx
          .insertInto('fitments')
          .values({
            id: f.id,
            tenant_id: auth.tenantId,
            part_id: id,
            vehicle_id: f.vehicleId,
            note: f.note ?? null,
          })
          .execute();
        await audit(
          trx,
          actorOf(request),
          { action: 'fitment.add', entityType: 'part', entityId: id, after: f },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );
  r.post(
    '/catalog/parts/:id/fitments/:linkId/remove',
    { schema: { params: subParams }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id, linkId } = request.params;
        const res = await trx
          .updateTable('fitments')
          .set({ removed_at: now() })
          .where('id', '=', linkId)
          .where('part_id', '=', id)
          .where('removed_at', 'is', null)
          .returning(['vehicle_id'])
          .executeTakeFirst();
        if (res === undefined) throw notFound();
        await audit(
          trx,
          actorOf(request),
          { action: 'fitment.remove', entityType: 'part', entityId: id, before: res },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );

  // --- interchange: linking two parts puts them (and their groups) in one group ---
  r.post(
    '/catalog/parts/:id/interchange',
    { schema: { params: idParamsSchema, body: linkInterchangeSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const other = request.body.partId;
        if (other === id) throw conflict();
        const groupOf = async (partId: string) =>
          (
            await trx
              .selectFrom('interchange_members')
              .select('group_id')
              .where('part_id', '=', partId)
              .where('removed_at', 'is', null)
              .executeTakeFirst()
          )?.group_id;
        const [ga, gb] = [await groupOf(id), await groupOf(other)];
        const join = async (groupId: string, partId: string) =>
          trx
            .insertInto('interchange_members')
            .values({ id: newId(), tenant_id: auth.tenantId, group_id: groupId, part_id: partId })
            .execute();
        if (ga === undefined && gb === undefined) {
          const g = newId();
          await trx
            .insertInto('interchange_groups')
            .values({ id: g, tenant_id: auth.tenantId })
            .execute();
          await join(g, id);
          await join(g, other);
        } else if (ga !== undefined && gb === undefined) {
          await join(ga, other);
        } else if (ga === undefined && gb !== undefined) {
          await join(gb, id);
        } else if (ga !== undefined && gb !== undefined && ga !== gb) {
          // Merge B into A: move its active members.
          const moved = await trx
            .updateTable('interchange_members')
            .set({ removed_at: now() })
            .where('group_id', '=', gb)
            .where('removed_at', 'is', null)
            .returning('part_id')
            .execute();
          for (const m of moved) await join(ga, m.part_id);
        }
        await audit(
          trx,
          actorOf(request),
          {
            action: 'interchange.link',
            entityType: 'part',
            entityId: id,
            after: { partId: other },
          },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );
  r.post(
    '/catalog/parts/:id/interchange/remove',
    { schema: { params: idParamsSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const res = await trx
          .updateTable('interchange_members')
          .set({ removed_at: now() })
          .where('part_id', '=', id)
          .where('removed_at', 'is', null)
          .returning('group_id')
          .executeTakeFirst();
        if (res === undefined) throw notFound();
        await audit(
          trx,
          actorOf(request),
          { action: 'interchange.unlink', entityType: 'part', entityId: id, before: res },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );

  // --- supersession (scenario 7): the new part also inherits the old part's fitments ---
  r.post(
    '/catalog/parts/:id/supersede',
    { schema: { params: idParamsSchema, body: supersedeSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const b = request.body;
        await trx
          .insertInto('supersessions')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            old_part_id: id,
            new_part_id: b.newPartId,
            effective_at: b.effectiveAt === undefined ? now() : new Date(b.effectiveAt),
            reason: b.reason ?? null,
            created_by: auth.userId,
          })
          .execute();
        const oldFitments = await trx
          .selectFrom('fitments')
          .select(['vehicle_id', 'note'])
          .where('part_id', '=', id)
          .where('removed_at', 'is', null)
          .execute();
        const existing = new Set(
          (
            await trx
              .selectFrom('fitments')
              .select('vehicle_id')
              .where('part_id', '=', b.newPartId)
              .where('removed_at', 'is', null)
              .execute()
          ).map((f) => f.vehicle_id),
        );
        const toCopy = oldFitments.filter((f) => !existing.has(f.vehicle_id));
        for (const f of toCopy) {
          await trx
            .insertInto('fitments')
            .values({
              id: newId(),
              tenant_id: auth.tenantId,
              part_id: b.newPartId,
              vehicle_id: f.vehicle_id,
              note: f.note,
            })
            .execute();
        }
        await audit(
          trx,
          actorOf(request),
          {
            action: 'part.supersede',
            entityType: 'part',
            entityId: id,
            after: { newPartId: b.newPartId, fitmentsCopied: toCopy.length },
            reason: b.reason ?? null,
          },
          now(),
        );
        return loadPartDetail(trx, id, now());
      }),
  );
}
