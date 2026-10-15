import {
  dec,
  divideRounded,
  formatFixed,
  idParamsSchema,
  listStockBalancesQuerySchema,
  listStockMovesQuerySchema,
} from '@autoparts/shared';
import type {
  AdjustmentReason,
  MoveKind,
  PartStock,
  StockBalanceRow,
  StockDocumentKind,
  StockMove,
} from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { PlatformDeps } from '../../auth/plugin';
import { notFound } from '../../errors';
import { seesCost } from '../../inventory/cost-view';
import { readMoneySettings } from '../../tenant-settings';
import type { Trx } from '../common';
import { inTenant, iso } from '../common';

/** Quantities per location for each part, for search results and the part page. */
export async function stockByPart(
  trx: Trx,
  partIds: readonly string[],
): Promise<Map<string, PartStock['locations']>> {
  const result = new Map<string, PartStock['locations']>();
  if (partIds.length === 0) return result;
  const rows = await trx
    .selectFrom('stock_balances as b')
    .innerJoin('locations as l', (j) =>
      j.onRef('l.tenant_id', '=', 'b.tenant_id').onRef('l.id', '=', 'b.location_id'),
    )
    .select(['b.part_id', 'b.location_id', 'b.quantity', 'b.last_in_at', 'b.last_out_at'])
    .where('b.part_id', 'in', [...new Set(partIds)])
    .where('l.archived_at', 'is', null)
    .orderBy('l.sort_order')
    .orderBy('l.name')
    .execute();
  for (const r of rows) {
    const list = result.get(r.part_id) ?? [];
    list.push({
      locationId: r.location_id,
      quantity: r.quantity,
      lastInAt: iso(r.last_in_at),
      lastOutAt: iso(r.last_out_at),
    });
    result.set(r.part_id, list);
  }
  return result;
}

/**
 * Stock reads (ADR 0020). Quantities need only a session: cashiers see them in every
 * location (product owner, 2026-10-06). Values need cost.view (ADR 0022).
 */
export function stockRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/stock/parts/:id',
    { schema: { params: idParamsSchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx, auth): Promise<PartStock> => {
        const { id } = request.params;
        const part = await trx
          .selectFrom('parts')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();
        if (part === undefined) throw notFound();
        const locations = (await stockByPart(trx, [id])).get(id) ?? [];
        const stock: PartStock = {
          partId: id,
          total: locations.reduce((sum, l) => sum + l.quantity, 0),
          locations,
        };
        if (!seesCost(auth)) return stock;
        const money = await readMoneySettings(trx);
        const cost = await trx
          .selectFrom('stock_costs')
          .select(['quantity', 'value'])
          .where('part_id', '=', id)
          .executeTakeFirst();
        const units = money.functional.minorUnits;
        const quantity = cost?.quantity ?? 0;
        const value = cost?.value ?? '0';
        return {
          ...stock,
          cost: {
            currency: money.functional.code,
            value: formatFixed(dec(value), units),
            averageCost:
              quantity > 0
                ? formatFixed(
                    divideRounded(value, String(quantity), units, money.roundingMode),
                    units,
                  )
                : null,
          },
        };
      }),
  );

  r.get(
    '/stock/balances',
    { schema: { querystring: listStockBalancesQuerySchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx): Promise<StockBalanceRow[]> => {
        const f = request.query;
        let q = trx
          .selectFrom('stock_balances as b')
          .innerJoin('parts as p', (j) =>
            j.onRef('p.tenant_id', '=', 'b.tenant_id').onRef('p.id', '=', 'b.part_id'),
          )
          .select([
            'b.part_id',
            'p.sku',
            'p.name_ar',
            'p.name_en',
            'b.location_id',
            'b.quantity',
            'b.last_in_at',
            'b.last_out_at',
          ])
          .orderBy('p.sku')
          .orderBy('b.location_id')
          .limit(f.limit);
        if (f.locationId !== undefined) q = q.where('b.location_id', '=', f.locationId);
        if (f.nonZero === true) q = q.where('b.quantity', '<>', 0);
        if (f.after !== undefined) q = q.where('p.sku', '>', f.after);
        return (await q.execute()).map((b) => ({
          partId: b.part_id,
          sku: b.sku,
          nameAr: b.name_ar,
          nameEn: b.name_en,
          locationId: b.location_id,
          quantity: b.quantity,
          lastInAt: iso(b.last_in_at),
          lastOutAt: iso(b.last_out_at),
        }));
      }),
  );

  r.get(
    '/stock/moves',
    { schema: { querystring: listStockMovesQuerySchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx, auth): Promise<StockMove[]> => {
        const f = request.query;
        let q = trx
          .selectFrom('stock_moves as m')
          .innerJoin('stock_documents as d', (j) =>
            j.onRef('d.tenant_id', '=', 'm.tenant_id').onRef('d.id', '=', 'm.document_id'),
          )
          .select([
            'm.id',
            'm.seq',
            'm.document_id',
            'd.kind as document_kind',
            'm.line_no',
            'm.part_id',
            'm.location_id',
            'm.kind',
            'm.reason',
            'm.quantity',
            'm.amount',
            'm.currency',
            'm.fx_rate',
            'm.fx_base',
            'm.fx_quote',
            'm.functional_amount',
            'm.occurred_at',
            'm.recorded_at',
          ])
          .orderBy('m.seq', 'desc')
          .limit(f.limit);
        if (f.partId !== undefined) q = q.where('m.part_id', '=', f.partId);
        if (f.locationId !== undefined) q = q.where('m.location_id', '=', f.locationId);
        if (f.documentId !== undefined) q = q.where('m.document_id', '=', f.documentId);
        if (f.before !== undefined) q = q.where('m.seq', '<', f.before);
        const showCost = seesCost(auth);
        return (await q.execute()).map((m) => ({
          id: m.id,
          seq: m.seq,
          documentId: m.document_id,
          documentKind: m.document_kind as StockDocumentKind,
          lineNo: m.line_no,
          partId: m.part_id,
          locationId: m.location_id,
          kind: m.kind as MoveKind,
          reason: m.reason as AdjustmentReason | null,
          quantity: m.quantity,
          occurredAt: m.occurred_at.toISOString(),
          recordedAt: m.recorded_at.toISOString(),
          ...(showCost && {
            cost: {
              amount: m.amount,
              currency: m.currency,
              fxRate: m.fx_rate,
              fxBase: m.fx_base,
              fxQuote: m.fx_quote,
              functionalAmount: m.functional_amount,
            },
          }),
        }));
      }),
  );
}
