import {
  approveCountSchema,
  createCountSchema,
  enterCountSchema,
  idParamsSchema,
  listReviewItemsQuerySchema,
  resolveReviewItemSchema,
  uuidSchema,
} from '@autoparts/shared';
import type { CountLine, ReviewItem, StockCount } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, notFound } from '../../errors';
import { postOnce, retryOnDuplicate, valueUnits } from '../../inventory/documents';
import type { StockOp } from '../../inventory/engine';
import { readMoneySettings } from '../../tenant-settings';
import type { Trx } from '../common';
import { actorOf, inTenant, iso } from '../common';

const lineParamsSchema = z.object({ id: uuidSchema, partId: uuidSchema });

async function loadCount(trx: Trx, id: string, lock = false): Promise<StockCount> {
  let q = trx
    .selectFrom('stock_counts')
    .select([
      'id',
      'location_id',
      'scope',
      'category_id',
      'status',
      'note',
      'created_at',
      'created_by',
      'closed_at',
      'document_id',
    ])
    .where('id', '=', id);
  if (lock) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (c === undefined) throw notFound();
  const n = await trx
    .selectFrom('stock_count_lines')
    .select([
      sql<number>`count(*)::int`.as('lines'),
      sql<number>`count(counted)::int`.as('counted'),
    ])
    .where('count_id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    id: c.id,
    locationId: c.location_id,
    scope: c.scope as StockCount['scope'],
    categoryId: c.category_id,
    status: c.status as StockCount['status'],
    note: c.note,
    createdAt: c.created_at.toISOString(),
    createdBy: c.created_by,
    closedAt: iso(c.closed_at),
    documentId: c.document_id,
    lines: n.lines,
    counted: n.counted,
  };
}

/**
 * Stock counts (ADR 0025). Supervisors and owners open and approve counts
 * (stock.approve_count); counters (stock.count) enter what they see without the expected
 * quantity (blind). Each entry records the location's quantity at that moment, so moves
 * during the count are not taken for differences.
 */
export function countRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const APPROVE = 'stock.approve_count' as const;

  r.get('/stock/counts', { config: { access: 'stock.count' } }, (request) =>
    inTenant(deps, request, async (trx) => {
      const ids = await trx
        .selectFrom('stock_counts')
        .select('id')
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      const counts = [];
      for (const { id } of ids) counts.push(await loadCount(trx, id));
      return counts;
    }),
  );

  r.post(
    '/stock/counts',
    { schema: { body: createCountSchema }, config: { access: APPROVE } },
    async (request, reply) => {
      const count = await retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const b = request.body;
          const existing = await trx
            .selectFrom('stock_counts')
            .select('location_id')
            .where('id', '=', b.id)
            .executeTakeFirst();
          if (existing !== undefined) {
            if (existing.location_id !== b.locationId)
              throw new ApiError(409, 'idempotency.conflict');
            return loadCount(trx, b.id);
          }
          const location = await trx
            .selectFrom('locations')
            .select('archived_at')
            .where('id', '=', b.locationId)
            .executeTakeFirst();
          if (location === undefined) throw notFound();
          if (location.archived_at !== null) throw new ApiError(409, 'location.archived');
          const open = await trx
            .selectFrom('stock_counts')
            .select('id')
            .where('location_id', '=', b.locationId)
            .where('status', '=', 'open')
            .executeTakeFirst();
          if (open !== undefined) throw new ApiError(409, 'count.open_exists');
          await trx
            .insertInto('stock_counts')
            .values({
              id: b.id,
              tenant_id: auth.tenantId,
              location_id: b.locationId,
              scope: b.scope,
              category_id: b.categoryId ?? null,
              note: b.note ?? null,
              created_by: auth.userId,
            })
            .execute();
          // The parts to count: a category's, a list, or everything that has stock here.
          let parts = trx
            .selectFrom('parts as p')
            .select('p.id')
            .where('p.archived_at', 'is', null);
          if (b.scope === 'category' && b.categoryId !== undefined) {
            parts = parts.where('p.category_id', '=', b.categoryId);
          } else if (b.scope === 'parts' && b.partIds !== undefined) {
            parts = parts.where('p.id', 'in', b.partIds);
          } else {
            parts = parts.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('stock_balances as sb')
                  .select('sb.part_id')
                  .whereRef('sb.part_id', '=', 'p.id')
                  .where('sb.location_id', '=', b.locationId)
                  .where('sb.quantity', '<>', 0),
              ),
            );
          }
          const ids = (await parts.execute()).map((p) => p.id);
          for (let i = 0; i < ids.length; i += 1000) {
            await trx
              .insertInto('stock_count_lines')
              .values(
                ids.slice(i, i + 1000).map((partId) => ({
                  tenant_id: auth.tenantId,
                  count_id: b.id,
                  part_id: partId,
                })),
              )
              .execute();
          }
          const created = await loadCount(trx, b.id);
          await audit(
            trx,
            actorOf(request),
            {
              action: 'stock_count.open',
              entityType: 'stock_count',
              entityId: b.id,
              after: created,
            },
            deps.now(),
          );
          return created;
        }),
      );
      return reply.code(201).send(count);
    },
  );

  r.get(
    '/stock/counts/:id',
    { schema: { params: idParamsSchema }, config: { access: 'stock.count' } },
    (request) => inTenant(deps, request, (trx) => loadCount(trx, request.params.id)),
  );

  r.get(
    '/stock/counts/:id/lines',
    { schema: { params: idParamsSchema }, config: { access: 'stock.count' } },
    (request) =>
      inTenant(deps, request, async (trx, auth): Promise<CountLine[]> => {
        await loadCount(trx, request.params.id);
        // Blind count: only approvers see what the system expected (ADR 0025).
        const approver = auth.permissions.has(APPROVE);
        const rows = await trx
          .selectFrom('stock_count_lines as l')
          .innerJoin('parts as p', (j) =>
            j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.part_id'),
          )
          .select([
            'l.part_id',
            'p.sku',
            'p.name_ar',
            'p.name_en',
            'l.counted',
            'l.counted_at',
            'l.expected',
          ])
          .where('l.count_id', '=', request.params.id)
          .orderBy('p.sku')
          .execute();
        return rows.map((l) => ({
          partId: l.part_id,
          sku: l.sku,
          nameAr: l.name_ar,
          nameEn: l.name_en,
          counted: l.counted,
          countedAt: iso(l.counted_at),
          ...(approver && {
            expected: l.expected,
            variance: l.counted === null || l.expected === null ? null : l.counted - l.expected,
          }),
        }));
      }),
  );

  // A counter enters what is on the shelf. The location's quantity at this moment is kept
  // with it, never shown to the counter.
  r.put(
    '/stock/counts/:id/lines/:partId',
    {
      schema: { params: lineParamsSchema, body: enterCountSchema },
      config: { access: 'stock.count' },
    },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const count = await loadCount(trx, request.params.id, true);
        if (count.status !== 'open') throw new ApiError(409, 'count.not_open');
        const { partId } = request.params;
        const part = await trx
          .selectFrom('parts')
          .select('id')
          .where('id', '=', partId)
          .executeTakeFirst();
        if (part === undefined) throw notFound();
        const balance = await trx
          .selectFrom('stock_balances')
          .select('quantity')
          .where('part_id', '=', partId)
          .where('location_id', '=', count.locationId)
          .executeTakeFirst();
        const now = deps.now();
        const values = {
          counted: request.body.counted,
          expected: balance?.quantity ?? 0,
          counted_at: now,
          counted_by: auth.userId,
        };
        await trx
          .insertInto('stock_count_lines')
          .values({ tenant_id: auth.tenantId, count_id: count.id, part_id: partId, ...values })
          .onConflict((oc) => oc.columns(['tenant_id', 'count_id', 'part_id']).doUpdateSet(values))
          .execute();
        return { partId, counted: values.counted, countedAt: now.toISOString() };
      }),
  );

  r.post(
    '/stock/counts/:id/cancel',
    { schema: { params: idParamsSchema }, config: { access: APPROVE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const count = await loadCount(trx, request.params.id, true);
        if (count.status === 'cancelled') return count;
        if (count.status !== 'open') throw new ApiError(409, 'count.not_open');
        const now = deps.now();
        await trx
          .updateTable('stock_counts')
          .set({ status: 'cancelled', closed_at: now, closed_by: auth.userId })
          .where('id', '=', count.id)
          .execute();
        const after = await loadCount(trx, count.id);
        await audit(
          trx,
          actorOf(request),
          {
            action: 'stock_count.cancel',
            entityType: 'stock_count',
            entityId: count.id,
            before: count,
            after,
          },
          now,
        );
        return after;
      }),
  );

  // Approval posts the differences (counted - expected at counting time) as count moves.
  r.post(
    '/stock/counts/:id/approve',
    { schema: { params: idParamsSchema, body: approveCountSchema }, config: { access: APPROVE } },
    (request) =>
      retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const count = await loadCount(trx, request.params.id, true);
          const b = request.body;
          if (count.status === 'approved' && count.documentId === b.documentId) {
            return { count, documentId: b.documentId };
          }
          if (count.status !== 'open') throw new ApiError(409, 'count.not_open');
          const m = await readMoneySettings(trx);
          const now = deps.now();
          const lines = await trx
            .selectFrom('stock_count_lines')
            .select(['part_id', 'counted', 'expected'])
            .where('count_id', '=', count.id)
            .where('counted', 'is not', null)
            .orderBy('part_id')
            .execute();
          const costs = new Map((b.costs ?? []).map((c) => [c.partId, c.unitCost]));
          await postOnce(
            trx,
            request,
            auth,
            {
              id: b.documentId,
              kind: 'count',
              note: count.note,
              body: { count: count.id, ...b },
              now,
            },
            async () => {
              const ops: StockOp[] = [];
              for (const l of lines) {
                const variance = (l.counted ?? 0) - (l.expected ?? 0);
                if (variance < 0) {
                  ops.push({
                    op: 'issue',
                    partId: l.part_id,
                    locationId: count.locationId,
                    quantity: -variance,
                    kind: 'count',
                  });
                } else if (variance > 0) {
                  const unitCost = costs.get(l.part_id);
                  ops.push(
                    unitCost === undefined
                      ? {
                          op: 'receive_at_average',
                          partId: l.part_id,
                          locationId: count.locationId,
                          quantity: variance,
                          kind: 'count',
                        }
                      : {
                          op: 'receive',
                          partId: l.part_id,
                          locationId: count.locationId,
                          quantity: variance,
                          kind: 'count',
                          value: await valueUnits(trx, m, unitCost, variance, now),
                        },
                  );
                }
              }
              return ops;
            },
            m,
          );
          await trx
            .updateTable('stock_counts')
            .set({
              status: 'approved',
              closed_at: now,
              closed_by: auth.userId,
              document_id: b.documentId,
            })
            .where('id', '=', count.id)
            .execute();
          return { count: await loadCount(trx, count.id), documentId: b.documentId };
        }),
      ),
  );

  // --- review items (ADR 0020) -------------------------------------------------------------

  r.get(
    '/stock/review-items',
    { schema: { querystring: listReviewItemsQuerySchema }, config: { access: 'stock.review' } },
    (request) =>
      inTenant(deps, request, async (trx): Promise<ReviewItem[]> => {
        const f = request.query;
        let q = trx
          .selectFrom('stock_review_items as i')
          .innerJoin('parts as p', (j) =>
            j.onRef('p.tenant_id', '=', 'i.tenant_id').onRef('p.id', '=', 'i.part_id'),
          )
          .innerJoin('stock_moves as m', (j) =>
            j.onRef('m.tenant_id', '=', 'i.tenant_id').onRef('m.id', '=', 'i.move_id'),
          )
          .leftJoin('stock_balances as b', (j) =>
            j
              .onRef('b.tenant_id', '=', 'i.tenant_id')
              .onRef('b.part_id', '=', 'i.part_id')
              .onRef('b.location_id', '=', 'i.location_id'),
          )
          .select([
            'i.id',
            'i.kind',
            'i.part_id',
            'p.sku',
            'p.name_ar',
            'p.name_en',
            'i.location_id',
            'i.move_id',
            'm.document_id',
            'b.quantity',
            'i.opened_at',
            'i.resolved_at',
            'i.resolved_by',
            'i.resolution_note',
          ])
          .orderBy('i.opened_at')
          .limit(f.limit);
        q =
          f.status === 'open'
            ? q.where('i.resolved_at', 'is', null)
            : q.where('i.resolved_at', 'is not', null);
        return (await q.execute()).map((i) => ({
          id: i.id,
          kind: i.kind as ReviewItem['kind'],
          partId: i.part_id,
          sku: i.sku,
          nameAr: i.name_ar,
          nameEn: i.name_en,
          locationId: i.location_id,
          moveId: i.move_id,
          documentId: i.document_id,
          quantity: i.quantity,
          openedAt: i.opened_at.toISOString(),
          resolvedAt: iso(i.resolved_at),
          resolvedBy: i.resolved_by,
          resolutionNote: i.resolution_note,
        }));
      }),
  );

  r.post(
    '/stock/review-items/:id/resolve',
    {
      schema: { params: idParamsSchema, body: resolveReviewItemSchema },
      config: { access: 'stock.review' },
    },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const item = await trx
          .selectFrom('stock_review_items')
          .select(['id', 'resolved_at'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (item === undefined) throw notFound();
        if (item.resolved_at !== null) throw new ApiError(409, 'resource.conflict');
        const now = deps.now();
        // The database refuses while the problem remains (stock.review_unresolved).
        await trx
          .updateTable('stock_review_items')
          .set({
            resolved_at: now,
            resolved_by: auth.userId,
            resolution_note: request.body.note,
            resolution_document_id: request.body.documentId ?? null,
          })
          .where('id', '=', id)
          .execute();
        await audit(
          trx,
          actorOf(request),
          {
            action: 'stock_review.resolve',
            entityType: 'stock_review_item',
            entityId: id,
            reason: request.body.note,
          },
          now,
        );
        return { id, resolvedAt: now.toISOString() };
      }),
  );
}
