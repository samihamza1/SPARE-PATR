import {
  adjustmentRequestSchema,
  idParamsSchema,
  partTransferRequestSchema,
  transferRequestSchema,
} from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, notFound } from '../../errors';
import {
  loadStockDocument,
  postOnce,
  retryOnDuplicate,
  valueUnits,
} from '../../inventory/documents';
import type { StockOp } from '../../inventory/engine';
import { readMoneySettings } from '../../tenant-settings';
import type { Trx } from '../common';
import { inTenant } from '../common';

/** Refuses parts or locations of another tenant, archived ones, or unknown ids. */
async function assertActive(trx: Trx, table: 'parts' | 'locations', ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await trx
    .selectFrom(table)
    .select(['id', 'archived_at'])
    .where('id', 'in', unique)
    .execute();
  if (rows.length !== unique.length) throw notFound();
  if (rows.some((r) => r.archived_at !== null)) {
    throw new ApiError(409, table === 'locations' ? 'location.archived' : 'resource.conflict');
  }
}

/**
 * Stock documents posted from the back office (ADR 0020, ADR 0025). The client chooses the
 * document id; a retry returns the same document.
 */
export function stockDocumentRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/stock/documents/:id',
    { schema: { params: idParamsSchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, (trx, auth) => loadStockDocument(trx, request.params.id, auth)),
  );

  r.post(
    '/stock/adjustments',
    { schema: { body: adjustmentRequestSchema }, config: { access: 'stock.adjust' } },
    (request) =>
      retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const b = request.body;
          const now = deps.now();
          const money = await readMoneySettings(trx);
          return postOnce(
            trx,
            request,
            auth,
            { id: b.id, kind: 'adjustment', note: b.note ?? null, body: b, now },
            async () => {
              await assertActive(trx, 'locations', [b.locationId]);
              await assertActive(
                trx,
                'parts',
                b.lines.map((l) => l.partId),
              );
              const ops: StockOp[] = [];
              for (const line of b.lines) {
                if (line.quantity < 0) {
                  ops.push({
                    op: 'issue',
                    partId: line.partId,
                    locationId: b.locationId,
                    quantity: -line.quantity,
                    kind: 'adjustment',
                    reason: b.reason,
                  });
                } else if (line.unitCost != null) {
                  ops.push({
                    op: 'receive',
                    partId: line.partId,
                    locationId: b.locationId,
                    quantity: line.quantity,
                    kind: 'adjustment',
                    reason: b.reason,
                    value: await valueUnits(trx, money, line.unitCost, line.quantity, now),
                  });
                } else {
                  ops.push({
                    op: 'receive_at_average',
                    partId: line.partId,
                    locationId: b.locationId,
                    quantity: line.quantity,
                    kind: 'adjustment',
                    reason: b.reason,
                  });
                }
              }
              return ops;
            },
            money,
          );
        }),
      ),
  );

  r.post(
    '/stock/transfers',
    { schema: { body: transferRequestSchema }, config: { access: 'stock.transfer' } },
    (request) =>
      retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const b = request.body;
          const money = await readMoneySettings(trx);
          return postOnce(
            trx,
            request,
            auth,
            { id: b.id, kind: 'transfer', note: b.note ?? null, body: b, now: deps.now() },
            async () => {
              await assertActive(trx, 'locations', [b.fromLocationId, b.toLocationId]);
              await assertActive(
                trx,
                'parts',
                b.lines.map((l) => l.partId),
              );
              return b.lines.map((line): StockOp => ({
                op: 'transfer',
                partId: line.partId,
                fromLocationId: b.fromLocationId,
                toLocationId: b.toLocationId,
                quantity: line.quantity,
              }));
            },
            money,
          );
        }),
      ),
  );

  // Supersession (BRIEF scenario 7): stock moves to the replacement only on request.
  r.post(
    '/stock/part-transfers',
    { schema: { body: partTransferRequestSchema }, config: { access: 'stock.adjust' } },
    (request) =>
      retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const b = request.body;
          const money = await readMoneySettings(trx);
          return postOnce(
            trx,
            request,
            auth,
            { id: b.id, kind: 'part_transfer', note: b.note ?? null, body: b, now: deps.now() },
            async () => {
              const link = await trx
                .selectFrom('supersessions as s')
                .innerJoin('parts as o', (j) =>
                  j.onRef('o.tenant_id', '=', 's.tenant_id').onRef('o.id', '=', 's.old_part_id'),
                )
                .innerJoin('parts as n', (j) =>
                  j.onRef('n.tenant_id', '=', 's.tenant_id').onRef('n.id', '=', 's.new_part_id'),
                )
                .select([
                  's.new_part_id',
                  'o.unit as old_unit',
                  'n.unit as new_unit',
                  'n.archived_at',
                ])
                .where('s.old_part_id', '=', b.partId)
                .where('s.removed_at', 'is', null)
                .executeTakeFirst();
              if (link?.archived_at !== null) {
                throw new ApiError(409, 'stock.no_replacement');
              }
              if (link.old_unit !== link.new_unit) throw new ApiError(409, 'stock.unit_mismatch');
              // Positive balances only (product owner, 2026-10-06); shortfalls stay for review.
              const balances = await trx
                .selectFrom('stock_balances as b')
                .innerJoin('locations as l', (j) =>
                  j.onRef('l.tenant_id', '=', 'b.tenant_id').onRef('l.id', '=', 'b.location_id'),
                )
                .select(['b.location_id', 'b.quantity'])
                .where('b.part_id', '=', b.partId)
                .where('b.quantity', '>', 0)
                .where('l.archived_at', 'is', null)
                .orderBy('l.sort_order')
                .orderBy('l.name')
                .execute();
              if (balances.length === 0) throw new ApiError(409, 'stock.insufficient');
              return balances.map((bal): StockOp => ({
                op: 'part_transfer',
                fromPartId: b.partId,
                toPartId: link.new_part_id,
                locationId: bal.location_id,
                quantity: bal.quantity,
              }));
            },
            money,
          );
        }),
      ),
  );
}
