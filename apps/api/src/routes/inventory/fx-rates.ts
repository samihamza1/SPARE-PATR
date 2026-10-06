import { businessDate, createFxRateSchema, listFxRatesQuerySchema } from '@autoparts/shared';
import type { CurrentFxRates, FxRateRecord } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, notFound } from '../../errors';
import { rateInEffect } from '../../inventory/fx';
import type { Trx } from '../common';
import { actorOf, inTenant } from '../common';

async function loadRates(
  trx: Trx,
  f: {
    id?: string | undefined;
    currency?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit?: number | undefined;
  },
): Promise<FxRateRecord[]> {
  let q = trx
    .selectFrom('fx_rates')
    .select([
      'id',
      'base_currency',
      'quote_currency',
      'rate',
      sql<string>`rate_date::text`.as('rate_date'),
      'note',
      'recorded_at',
      'recorded_by',
    ])
    .orderBy('fx_rates.rate_date', 'desc')
    .orderBy('recorded_at', 'desc')
    .orderBy('id', 'desc');
  if (f.id !== undefined) q = q.where('id', '=', f.id);
  const currency = f.currency;
  if (currency !== undefined) {
    q = q.where((eb) =>
      eb.or([eb('base_currency', '=', currency), eb('quote_currency', '=', currency)]),
    );
  }
  if (f.from !== undefined) q = q.where('fx_rates.rate_date', '>=', sql<Date>`${f.from}::date`);
  if (f.to !== undefined) q = q.where('fx_rates.rate_date', '<=', sql<Date>`${f.to}::date`);
  if (f.limit !== undefined) q = q.limit(f.limit);
  return (await q.execute()).map((r) => ({
    id: r.id,
    base: r.base_currency,
    quote: r.quote_currency,
    rate: r.rate,
    rateDate: r.rate_date,
    note: r.note,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
  }));
}

async function tenantClock(trx: Trx, now: Date) {
  const t = await trx
    .selectFrom('tenants')
    .select(['functional_currency', 'timezone'])
    .executeTakeFirstOrThrow();
  return { functional: t.functional_currency, today: businessDate(now, t.timezone) };
}

/**
 * Exchange rates entered by hand, daily (product owner, 2026-10-06; ADR 0019). Anyone
 * signed in reads them (cashiers take payments in several currencies); fx.manage records.
 */
export function fxRateRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/fx-rates',
    { schema: { querystring: listFxRatesQuerySchema }, config: { access: 'authenticated' } },
    (request) => inTenant(deps, request, (trx) => loadRates(trx, request.query)),
  );

  r.get('/fx-rates/current', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, async (trx): Promise<CurrentFxRates> => {
      const { functional, today } = await tenantClock(trx, deps.now());
      const currencies = await trx
        .selectFrom('tenant_currencies')
        .select('code')
        .where('is_active', '=', true)
        .where('code', '<>', functional)
        .orderBy('sort_order')
        .orderBy('code')
        .execute();
      const rates = [];
      for (const { code } of currencies) {
        const rate = await rateInEffect(trx, functional, code, today);
        const [record] = rate === null ? [] : await loadRates(trx, { id: rate.id });
        rates.push({
          currency: code,
          rate: record ?? null,
          enteredToday: record?.rateDate === today,
        });
      }
      return { businessDate: today, functionalCurrency: functional, rates };
    }),
  );

  r.post(
    '/fx-rates',
    { schema: { body: createFxRateSchema }, config: { access: 'fx.manage' } },
    async (request, reply) => {
      const record = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        const now = deps.now();
        const { functional, today } = await tenantClock(trx, now);
        const rateDate = b.rateDate ?? today;
        if (rateDate > today) throw new ApiError(400, 'fx.future_date');
        if (b.base !== functional && b.quote !== functional) {
          throw new ApiError(400, 'request.invalid');
        }
        await trx
          .insertInto('fx_rates')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            base_currency: b.base,
            quote_currency: b.quote,
            rate: b.rate,
            rate_date: rateDate,
            note: b.note ?? null,
            recorded_at: now,
            recorded_by: auth.userId,
          })
          .execute();
        const [created] = await loadRates(trx, { id: b.id });
        if (created === undefined) throw notFound();
        await audit(
          trx,
          actorOf(request),
          { action: 'fx_rate.create', entityType: 'fx_rate', entityId: b.id, after: created },
          now,
        );
        return created;
      });
      return reply.code(201).send(record);
    },
  );
}
