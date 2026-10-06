import {
  DECIMAL_PATTERN,
  OPENING_LINE_STATUSES,
  businessDate,
  createOpeningSchema,
  dec,
  divideRounded,
  formatFixed,
  idParamsSchema,
  importMappingSchema,
  listOpeningLinesQuerySchema,
  money,
  round,
  toDecimalString,
  updateOpeningLineSchema,
  updateOpeningSchema,
  uuidSchema,
} from '@autoparts/shared';
import type {
  Decimal,
  OpeningDraft,
  OpeningLine,
  OpeningLineStatus,
  RoundingMode,
} from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../audit';
import type { AuthContext } from '../../auth/context';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, forbidden, notFound } from '../../errors';
import { loadStockDocument, postOnce, retryOnDuplicate } from '../../inventory/documents';
import type { StockOp } from '../../inventory/engine';
import type { RecordedRate } from '../../inventory/fx';
import { rateInEffect, valueAmount } from '../../inventory/fx';
import type { MoneyContext } from '../../tenant-settings';
import { readMoneySettings } from '../../tenant-settings';
import type { Trx } from '../common';
import { actorOf, inTenant } from '../common';

/** Opening stock shows and enters costs, so it needs cost.view too (ADR 0024). */
function requireCostView(auth: AuthContext): void {
  if (!auth.permissions.has('cost.view')) throw forbidden();
}

const lineParamsSchema = z.object({ id: uuidSchema, partId: uuidSchema });

interface DraftRow {
  id: string;
  batch_id: string;
  location_id: string;
  as_of: string;
  cost_currency: string;
  fx_rate_id: string | null;
  status: string;
  posted_at: Date | null;
}

async function draftRow(trx: Trx, id: string, lock = false): Promise<DraftRow> {
  let q = trx
    .selectFrom('opening_stock_drafts')
    .select([
      'id',
      'batch_id',
      'location_id',
      sql<string>`as_of::text`.as('as_of'),
      'cost_currency',
      'fx_rate_id',
      'status',
      'posted_at',
    ])
    .where('id', '=', id);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound();
  return row;
}

async function minorUnitsOf(trx: Trx, currency: string): Promise<number> {
  const row = await trx
    .selectFrom('tenant_currencies')
    .select('minor_units')
    .where('code', '=', currency)
    .executeTakeFirstOrThrow();
  return row.minor_units;
}

/** The rate a draft converts with: the chosen one, else the one in effect on its date. */
async function draftRate(trx: Trx, d: DraftRow, m: MoneyContext): Promise<RecordedRate | null> {
  if (d.cost_currency === m.functional.code) return null;
  if (d.fx_rate_id !== null) {
    const r = await trx
      .selectFrom('fx_rates')
      .select([
        'id',
        'base_currency',
        'quote_currency',
        'rate',
        sql<string>`rate_date::text`.as('d'),
      ])
      .where('id', '=', d.fx_rate_id)
      .executeTakeFirstOrThrow();
    return {
      id: r.id,
      base: r.base_currency,
      quote: r.quote_currency,
      rate: r.rate,
      rateDate: r.d,
    };
  }
  return rateInEffect(trx, m.functional.code, d.cost_currency, d.as_of);
}

/** Total cost of a line, rounded once (ADR 0024). */
function lineAmount(
  line: {
    quantity: number | null;
    file_quantity: string | null;
    file_cost_total: string | null;
    unit_cost: string | null;
    cost_source: string | null;
  },
  units: number,
  mode: RoundingMode,
): string | null {
  if (line.quantity === null || line.quantity === 0) return null;
  if (line.cost_source === 'entered' && line.unit_cost !== null) {
    return formatFixed(round(dec(line.unit_cost).times(String(line.quantity)), units, mode), units);
  }
  if (line.cost_source === 'file' && line.file_cost_total !== null && line.file_quantity !== null) {
    // The file's exact total scaled to the quantity kept: one division, one rounding.
    const total = dec(line.file_cost_total).times(String(line.quantity));
    return formatFixed(divideRounded(total, line.file_quantity, units, mode), units);
  }
  return null;
}

async function loadDraft(trx: Trx, id: string, m: MoneyContext): Promise<OpeningDraft> {
  const d = await draftRow(trx, id);
  const batch = await trx
    .selectFrom('import_batches')
    .select('file_name')
    .where('id', '=', d.batch_id)
    .executeTakeFirstOrThrow();
  const counts = Object.fromEntries(OPENING_LINE_STATUSES.map((s) => [s, 0])) as Record<
    OpeningLineStatus,
    number
  >;
  const byStatus = await trx
    .selectFrom('opening_stock_lines')
    .select(['status', sql<number>`count(*)::int`.as('n')])
    .where('draft_id', '=', id)
    .groupBy('status')
    .execute();
  for (const r of byStatus) counts[r.status as OpeningLineStatus] = r.n;
  const ready = await trx
    .selectFrom('opening_stock_lines')
    .select(['quantity', 'amount'])
    .where('draft_id', '=', id)
    .where('status', '=', 'ready')
    .execute();
  const rate = await draftRate(trx, d, m);
  const sameCurrency = d.cost_currency === m.functional.code;
  let quantity = 0;
  let amount = dec('0');
  let functional: Decimal | null = sameCurrency || rate !== null ? dec('0') : null;
  for (const line of ready) {
    quantity += line.quantity ?? 0;
    const a = dec(line.amount ?? '0');
    amount = amount.plus(a);
    if (functional !== null) {
      // Each line converts on its own, exactly as posting will.
      const v = valueAmount(money(a, d.cost_currency), rate, m);
      functional = functional.plus(dec(v.functionalAmount));
    }
  }
  const units = await minorUnitsOf(trx, d.cost_currency);
  return {
    id: d.id,
    batchId: d.batch_id,
    fileName: batch.file_name,
    locationId: d.location_id,
    asOf: d.as_of,
    costCurrency: d.cost_currency,
    functionalCurrency: m.functional.code,
    fxRate:
      rate === null ? null : { id: rate.id, base: rate.base, quote: rate.quote, rate: rate.rate },
    status: d.status as OpeningDraft['status'],
    counts,
    totals: {
      quantity,
      amount: formatFixed(amount, units),
      functionalAmount:
        functional === null ? null : formatFixed(functional, m.functional.minorUnits),
    },
    postedAt: d.posted_at === null ? null : d.posted_at.toISOString(),
  };
}

/** Marks lines of parts that already have opening stock at the draft's location. */
async function markAlreadyOpened(trx: Trx, draftId: string, locationId: string): Promise<void> {
  await trx
    .updateTable('opening_stock_lines')
    .set({ exclusion: null })
    .where('draft_id', '=', draftId)
    .where('exclusion', '=', 'already_opened')
    .execute();
  await trx
    .updateTable('opening_stock_lines as l')
    .set({ exclusion: 'already_opened' })
    .where('l.draft_id', '=', draftId)
    .where('l.exclusion', 'is', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('stock_moves as m')
          .select('m.id')
          .whereRef('m.part_id', '=', 'l.part_id')
          .where('m.location_id', '=', locationId)
          .where('m.kind', '=', 'opening'),
      ),
    )
    .execute();
}

/**
 * Builds the draft's lines from an applied import batch: one line per part; repeated rows
 * are combined (quantities summed, costs weighted exactly) (product owner, 2026-10-06).
 */
async function buildLines(
  trx: Trx,
  tenantId: string,
  draftId: string,
  batchId: string,
  costUnits: number,
  mode: RoundingMode,
): Promise<void> {
  const rows = await trx
    .selectFrom('import_rows')
    .select([
      'part_id',
      sql<string | null>`parsed->>'quantity'`.as('quantity'),
      sql<string | null>`parsed->>'cost'`.as('cost'),
    ])
    .where('batch_id', '=', batchId)
    .where('part_id', 'is not', null)
    .where('skipped_by_user', '=', false)
    .where('decision', 'in', ['create', 'update', 'merge'])
    .orderBy('row_number')
    .execute();
  const valid = (s: string | null) => (s !== null && DECIMAL_PATTERN.test(s) ? dec(s) : null);
  const parts = new Map<
    string,
    { rows: number; qty: Decimal; costed: Decimal; costedQty: Decimal; missing: boolean }
  >();
  for (const r of rows) {
    if (r.part_id === null) continue;
    const p = parts.get(r.part_id) ?? {
      rows: 0,
      qty: dec('0'),
      costed: dec('0'),
      costedQty: dec('0'),
      missing: false,
    };
    p.rows += 1;
    const q = valid(r.quantity);
    if (q?.gt(0) === true) {
      p.qty = p.qty.plus(q);
      const c = valid(r.cost);
      // A missing or zero cost needs one entered before posting (product owner, 2026-10-06).
      if (c?.gt(0) === true) {
        p.costed = p.costed.plus(q.times(c));
        p.costedQty = p.costedQty.plus(q);
      } else {
        p.missing = true;
      }
    }
    parts.set(r.part_id, p);
  }
  const values = [...parts.entries()].map(([partId, p]) => {
    const whole = p.qty.isInteger() && p.qty.lte(1_000_000);
    const quantity = whole ? p.qty.toNumber() : null;
    const fileCost = !p.missing && p.qty.gt(0) ? toDecimalString(p.costed) : null;
    const amount =
      fileCost !== null && quantity !== null
        ? formatFixed(round(dec(fileCost), costUnits, mode), costUnits)
        : null;
    return {
      tenant_id: tenantId,
      draft_id: draftId,
      part_id: partId,
      rows: p.rows,
      file_quantity: toDecimalString(p.qty),
      quantity,
      file_cost_total: fileCost,
      amount,
      cost_source: amount === null ? null : 'file',
      // Offered when some rows had no cost: the average of those that had one.
      suggested_unit_cost:
        p.missing && p.costedQty.gt(0)
          ? toDecimalString(divideRounded(p.costed, p.costedQty, costUnits + 4, mode))
          : null,
      exclusion: p.qty.isZero() ? 'no_quantity' : null,
    };
  });
  for (let i = 0; i < values.length; i += 1000) {
    await trx
      .insertInto('opening_stock_lines')
      .values(values.slice(i, i + 1000))
      .execute();
  }
}

export function openingRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const access = 'stock.opening' as const;

  r.post(
    '/stock/opening',
    { schema: { body: createOpeningSchema }, config: { access } },
    async (request, reply) => {
      const draft = await retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          requireCostView(auth);
          const b = request.body;
          const m = await readMoneySettings(trx);
          const existing = await trx
            .selectFrom('opening_stock_drafts')
            .select(['id', 'batch_id'])
            .where('id', '=', b.id)
            .executeTakeFirst();
          if (existing !== undefined) {
            if (existing.batch_id !== b.batchId) throw new ApiError(409, 'idempotency.conflict');
            return loadDraft(trx, b.id, m);
          }
          const batch = await trx
            .selectFrom('import_batches')
            .select(['id', 'status', 'mapping'])
            .where('id', '=', b.batchId)
            .executeTakeFirst();
          if (batch === undefined) throw notFound();
          if (batch.status !== 'applied') throw new ApiError(409, 'opening.not_applied');
          const live = await trx
            .selectFrom('opening_stock_drafts')
            .select('id')
            .where('batch_id', '=', b.batchId)
            .where('status', '<>', 'discarded')
            .executeTakeFirst();
          if (live !== undefined) throw new ApiError(409, 'opening.exists');
          const mapping = importMappingSchema.parse(batch.mapping);
          const costCurrency = mapping.costCurrency ?? m.functional.code;
          const location =
            b.locationId ??
            (
              await trx
                .selectFrom('locations')
                .select('id')
                .where('is_default', '=', true)
                .executeTakeFirst()
            )?.id;
          if (location === undefined) throw notFound();
          const today = businessDate(deps.now(), m.timezone);
          const asOf = b.asOf ?? today;
          if (asOf > today) throw new ApiError(400, 'fx.future_date');
          await trx
            .insertInto('opening_stock_drafts')
            .values({
              id: b.id,
              tenant_id: auth.tenantId,
              batch_id: b.batchId,
              location_id: location,
              as_of: asOf,
              cost_currency: costCurrency,
              created_by: auth.userId,
            })
            .execute();
          const units = await minorUnitsOf(trx, costCurrency);
          await buildLines(trx, auth.tenantId, b.id, b.batchId, units, m.roundingMode);
          await markAlreadyOpened(trx, b.id, location);
          return loadDraft(trx, b.id, m);
        }),
      );
      return reply.code(201).send(draft);
    },
  );

  r.get(
    '/stock/opening/:id',
    { schema: { params: idParamsSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        requireCostView(auth);
        return loadDraft(trx, request.params.id, await readMoneySettings(trx));
      }),
  );

  r.get(
    '/stock/opening/:id/lines',
    {
      schema: { params: idParamsSchema, querystring: listOpeningLinesQuerySchema },
      config: { access },
    },
    (request) =>
      inTenant(deps, request, async (trx, auth): Promise<OpeningLine[]> => {
        requireCostView(auth);
        await draftRow(trx, request.params.id);
        const f = request.query;
        let q = trx
          .selectFrom('opening_stock_lines as l')
          .innerJoin('parts as p', (j) =>
            j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.part_id'),
          )
          .select([
            'l.part_id',
            'p.sku',
            'p.name_ar',
            'p.name_en',
            'l.rows',
            'l.file_quantity',
            'l.quantity',
            'l.amount',
            'l.unit_cost',
            'l.cost_source',
            'l.suggested_unit_cost',
            'l.status',
            'l.exclusion',
          ])
          .where('l.draft_id', '=', request.params.id)
          .orderBy('p.sku')
          .limit(f.limit);
        if (f.status !== undefined) q = q.where('l.status', '=', f.status);
        if (f.after !== undefined) q = q.where('p.sku', '>', f.after);
        return (await q.execute()).map((l) => ({
          partId: l.part_id,
          sku: l.sku,
          nameAr: l.name_ar,
          nameEn: l.name_en,
          rows: l.rows,
          fileQuantity: l.file_quantity,
          quantity: l.quantity,
          amount: l.amount,
          unitCost:
            l.cost_source === 'entered'
              ? l.unit_cost
              : l.amount !== null && l.quantity !== null && l.quantity > 0
                ? toDecimalString(dec(l.amount).div(String(l.quantity)).toDecimalPlaces(6))
                : null,
          costSource: l.cost_source as OpeningLine['costSource'],
          suggestedUnitCost: l.suggested_unit_cost,
          status: l.status as OpeningLineStatus,
          exclusion: l.exclusion as OpeningLine['exclusion'],
        }));
      }),
  );

  r.patch(
    '/stock/opening/:id',
    { schema: { params: idParamsSchema, body: updateOpeningSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        requireCostView(auth);
        const m = await readMoneySettings(trx);
        const d = await draftRow(trx, request.params.id, true);
        if (d.status !== 'draft') throw new ApiError(409, 'resource.conflict');
        const b = request.body;
        if (b.asOf !== undefined && b.asOf > businessDate(deps.now(), m.timezone)) {
          throw new ApiError(400, 'fx.future_date');
        }
        if (b.fxRateId != null) {
          const rate = await trx
            .selectFrom('fx_rates')
            .select(['base_currency', 'quote_currency'])
            .where('id', '=', b.fxRateId)
            .executeTakeFirst();
          if (rate === undefined) throw notFound();
          const pair = [rate.base_currency, rate.quote_currency];
          if (!pair.includes(d.cost_currency) || !pair.includes(m.functional.code)) {
            throw new ApiError(400, 'request.invalid');
          }
        }
        await trx
          .updateTable('opening_stock_drafts')
          .set({
            ...(b.locationId !== undefined && { location_id: b.locationId }),
            ...(b.asOf !== undefined && { as_of: b.asOf }),
            ...(b.fxRateId !== undefined && { fx_rate_id: b.fxRateId }),
          })
          .where('id', '=', d.id)
          .execute();
        if (b.locationId !== undefined) await markAlreadyOpened(trx, d.id, b.locationId);
        return loadDraft(trx, d.id, m);
      }),
  );

  r.patch(
    '/stock/opening/:id/lines/:partId',
    { schema: { params: lineParamsSchema, body: updateOpeningLineSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        requireCostView(auth);
        const m = await readMoneySettings(trx);
        const d = await draftRow(trx, request.params.id, true);
        if (d.status !== 'draft') throw new ApiError(409, 'resource.conflict');
        const line = await trx
          .selectFrom('opening_stock_lines')
          .select([
            'quantity',
            'file_quantity',
            'file_cost_total',
            'unit_cost',
            'cost_source',
            'exclusion',
          ])
          .where('draft_id', '=', d.id)
          .where('part_id', '=', request.params.partId)
          .executeTakeFirst();
        if (line === undefined) throw notFound();
        if (line.exclusion === 'already_opened') throw new ApiError(409, 'resource.conflict');
        const b = request.body;
        const next = { ...line };
        if (b.quantity !== undefined) next.quantity = b.quantity;
        if (b.unitCost !== undefined) {
          if (b.unitCost === null) {
            next.unit_cost = null;
            next.cost_source = next.file_cost_total !== null ? 'file' : null;
          } else {
            next.unit_cost = b.unitCost;
            next.cost_source = 'entered';
          }
        }
        if (b.excluded !== undefined) next.exclusion = b.excluded ? 'by_user' : null;
        const units = await minorUnitsOf(trx, d.cost_currency);
        const amount = lineAmount(next, units, m.roundingMode);
        await trx
          .updateTable('opening_stock_lines')
          .set({
            quantity: next.quantity,
            unit_cost: next.unit_cost,
            amount,
            cost_source: amount === null ? null : next.cost_source,
            exclusion: next.exclusion,
          })
          .where('draft_id', '=', d.id)
          .where('part_id', '=', request.params.partId)
          .execute();
        return loadDraft(trx, d.id, m);
      }),
  );

  r.post(
    '/stock/opening/:id/discard',
    { schema: { params: idParamsSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        requireCostView(auth);
        const d = await draftRow(trx, request.params.id, true);
        if (d.status === 'posted') throw new ApiError(409, 'resource.conflict');
        if (d.status === 'draft') {
          await trx
            .updateTable('opening_stock_drafts')
            .set({ status: 'discarded' })
            .where('id', '=', d.id)
            .execute();
        }
        return loadDraft(trx, d.id, await readMoneySettings(trx));
      }),
  );

  // Posts the draft as one opening document whose id is the draft's id (idempotent).
  r.post(
    '/stock/opening/:id/post',
    { schema: { params: idParamsSchema }, config: { access } },
    (request) =>
      retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          requireCostView(auth);
          const m = await readMoneySettings(trx);
          const d = await draftRow(trx, request.params.id, true);
          if (d.status === 'posted') return loadStockDocument(trx, d.id, auth);
          if (d.status !== 'draft') throw new ApiError(409, 'resource.conflict');
          const lines = await trx
            .selectFrom('opening_stock_lines')
            .select(['part_id', 'quantity', 'amount', 'status'])
            .where('draft_id', '=', d.id)
            .execute();
          if (lines.some((l) => l.status === 'needs_cost' || l.status === 'needs_quantity')) {
            throw new ApiError(409, 'opening.not_ready');
          }
          const ready = lines.filter((l) => l.status === 'ready');
          if (ready.length === 0) throw new ApiError(409, 'opening.not_ready');
          const rate = await draftRate(trx, d, m);
          const now = deps.now();
          const doc = await postOnce(
            trx,
            request,
            auth,
            { id: d.id, kind: 'opening', note: null, body: { draft: d.id }, now },
            () =>
              Promise.resolve(
                ready.map((l): StockOp => ({
                  op: 'receive',
                  partId: l.part_id,
                  locationId: d.location_id,
                  quantity: l.quantity ?? 0,
                  kind: 'opening',
                  value: valueAmount(money(l.amount ?? '0', d.cost_currency), rate, m),
                })),
              ),
            m,
          );
          await trx
            .updateTable('opening_stock_drafts')
            .set({
              status: 'posted',
              posted_at: now,
              posted_by: auth.userId,
              ...(rate !== null && { fx_rate_id: rate.id }),
            })
            .where('id', '=', d.id)
            .execute();
          await audit(
            trx,
            actorOf(request),
            {
              action: 'stock.opening_posted',
              entityType: 'opening_stock',
              entityId: d.id,
              after: { lines: ready.length, batchId: d.batch_id, fxRateId: rate?.id ?? null },
            },
            now,
          );
          return doc;
        }),
      ),
  );
}
