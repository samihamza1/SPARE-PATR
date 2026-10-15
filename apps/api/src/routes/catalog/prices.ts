import {
  createPriceListSchema,
  dec,
  formatFixed,
  idParamsSchema,
  setPriceSchema,
  toDecimalString,
  updatePriceListSchema,
} from '@autoparts/shared';
import type { PriceEntry, PriceList } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError, notFound } from '../../errors';
import type { Trx } from '../../catalog/mappers';
import { currentPrices, iso } from '../../catalog/mappers';
import { actorOf, inTenant } from '../common';

const MANAGE = 'prices.manage' as const;

async function loadPriceLists(trx: Trx, id?: string): Promise<PriceList[]> {
  let q = trx
    .selectFrom('price_lists')
    .select(['id', 'name', 'currency', 'is_default', 'archived_at'])
    .orderBy('currency')
    .orderBy('name');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((l) => ({
    id: l.id,
    name: l.name,
    currency: l.currency,
    isDefault: l.is_default,
    archivedAt: iso(l.archived_at),
  }));
}

async function loadPriceList(trx: Trx, id: string): Promise<PriceList> {
  const [list] = await loadPriceLists(trx, id);
  if (list === undefined) throw notFound();
  return list;
}

/** Only one active default list per currency: making a list default demotes the previous one. */
async function demoteDefault(trx: Trx, currency: string, except: string): Promise<void> {
  await trx
    .updateTable('price_lists')
    .set({ is_default: false })
    .where('currency', '=', currency)
    .where('is_default', '=', true)
    .where('id', '!=', except)
    .execute();
}

export function priceRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => deps.now();

  r.get('/catalog/price-lists', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadPriceLists(trx)),
  );

  r.post(
    '/catalog/price-lists',
    { schema: { body: createPriceListSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const list = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        if (b.isDefault === true) await demoteDefault(trx, b.currency, b.id);
        await trx
          .insertInto('price_lists')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            name: b.name,
            currency: b.currency,
            is_default: b.isDefault ?? false,
          })
          .execute();
        const after = await loadPriceList(trx, b.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'price_list.create', entityType: 'price_list', entityId: b.id, after },
          now(),
        );
        return after;
      });
      return reply.code(201).send(list);
    },
  );

  r.patch(
    '/catalog/price-lists/:id',
    { schema: { params: idParamsSchema, body: updatePriceListSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const before = await loadPriceList(trx, id);
        const b = request.body;
        if (b.isDefault === true) await demoteDefault(trx, before.currency, id);
        await trx
          .updateTable('price_lists')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.isDefault !== undefined && { is_default: b.isDefault }),
            ...(b.archived !== undefined && { archived_at: b.archived ? now() : null }),
          })
          .where('id', '=', id)
          .execute();
        const after = await loadPriceList(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'price_list.update', entityType: 'price_list', entityId: id, before, after },
          now(),
        );
        return after;
      }),
  );

  // A price change is a new row (append-only, invariant 7) and an audit entry.
  r.post(
    '/catalog/price-lists/:id/prices',
    { schema: { params: idParamsSchema, body: setPriceSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const entry = await inTenant(deps, request, async (trx, auth) => {
        const list = await trx
          .selectFrom('price_lists as l')
          .innerJoin('tenant_currencies as c', (j) =>
            j.onRef('c.tenant_id', '=', 'l.tenant_id').onRef('c.code', '=', 'l.currency'),
          )
          .select(['l.id', 'l.currency', 'l.archived_at', 'c.minor_units'])
          .where('l.id', '=', request.params.id)
          .executeTakeFirst();
        // An archived list takes no new prices.
        if (list?.archived_at !== null) throw notFound();
        const b = request.body;
        const price = dec(b.price);
        // Never round silently: a price finer than the currency allows is rejected.
        if (price.isNegative() || price.decimalPlaces() > list.minor_units) {
          throw new ApiError(400, 'request.invalid');
        }
        const at = now();
        const effectiveAt = b.effectiveAt === undefined ? at : new Date(b.effectiveAt);
        // Future-dated changes are allowed (scheduled price change); back-dating is not,
        // so the history always shows what was in effect when.
        if (effectiveAt < at) throw new ApiError(400, 'request.invalid');

        const before = (await currentPrices(trx, list.id, [b.partId], at)).get(b.partId) ?? null;
        await trx
          .insertInto('part_prices')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            price_list_id: list.id,
            part_id: b.partId,
            price: toDecimalString(price),
            effective_at: effectiveAt,
            recorded_by: auth.userId,
            source: 'manual',
            reason: b.reason ?? null,
          })
          .execute();
        const amount = formatFixed(price, list.minor_units);
        await audit(
          trx,
          actorOf(request),
          {
            action: 'price.set',
            entityType: 'part',
            entityId: b.partId,
            before: { priceListId: list.id, price: before },
            after: { priceListId: list.id, price: amount, effectiveAt: effectiveAt.toISOString() },
            reason: b.reason ?? null,
          },
          at,
        );
        return { id: b.id, priceListId: list.id, amount, currency: list.currency };
      });
      return reply.code(201).send(entry);
    },
  );

  r.get(
    '/catalog/parts/:id/prices',
    { schema: { params: idParamsSchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx): Promise<PriceEntry[]> => {
        const part = await trx
          .selectFrom('parts')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (part === undefined) throw notFound();
        const rows = await trx
          .selectFrom('part_prices as pp')
          .innerJoin('price_lists as l', (j) =>
            j.onRef('l.tenant_id', '=', 'pp.tenant_id').onRef('l.id', '=', 'pp.price_list_id'),
          )
          .innerJoin('tenant_currencies as c', (j) =>
            j.onRef('c.tenant_id', '=', 'l.tenant_id').onRef('c.code', '=', 'l.currency'),
          )
          .select([
            'pp.id',
            'pp.price_list_id',
            'pp.price',
            'l.currency',
            'c.minor_units',
            'pp.effective_at',
            'pp.recorded_at',
            'pp.recorded_by',
            'pp.source',
            'pp.reason',
          ])
          .where('pp.part_id', '=', part.id)
          .orderBy('pp.effective_at', 'desc')
          .orderBy('pp.recorded_at', 'desc')
          .limit(500)
          .execute();
        return rows.map((p) => ({
          id: p.id,
          priceListId: p.price_list_id,
          price: formatFixed(dec(p.price), p.minor_units),
          currency: p.currency,
          effectiveAt: p.effective_at.toISOString(),
          recordedAt: p.recorded_at.toISOString(),
          recordedBy: p.recorded_by,
          source: p.source as PriceEntry['source'],
          reason: p.reason,
        }));
      }),
  );
}
