import {
  createCurrencySchema,
  idParamsSchema,
  tenantSettingsSchema,
  updateCurrencySchema,
  updateSettingsSchema,
} from '@autoparts/shared';
import type { Currency } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import type { PlatformDeps } from '../auth/plugin';
import { notFound } from '../errors';
import type { Trx } from './common';
import { actorOf, inTenant } from './common';

async function loadSettings(trx: Trx) {
  const t = await trx
    .selectFrom('tenants')
    .select(['name', 'default_locale', 'timezone', 'functional_currency', 'settings'])
    .executeTakeFirstOrThrow();
  const parsed = tenantSettingsSchema.safeParse(t.settings);
  return {
    name: t.name,
    defaultLocale: t.default_locale,
    timezone: t.timezone,
    functionalCurrency: t.functional_currency,
    settings: parsed.success ? parsed.data : null,
  };
}

async function loadCurrencies(trx: Trx, id?: string): Promise<Currency[]> {
  const { functional_currency } = await trx
    .selectFrom('tenants')
    .select('functional_currency')
    .executeTakeFirstOrThrow();
  let q = trx
    .selectFrom('tenant_currencies')
    .select(['id', 'code', 'minor_units', 'cash_increment', 'is_active', 'sort_order'])
    .orderBy('sort_order')
    .orderBy('code');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((c) => ({
    id: c.id,
    code: c.code,
    minorUnits: c.minor_units,
    cashIncrement: c.cash_increment,
    isActive: c.is_active,
    sortOrder: c.sort_order,
    isFunctional: c.code === functional_currency,
  }));
}

export function settingsRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const access = 'settings.manage' as const;

  r.get('/settings', { config: { access } }, (request) =>
    inTenant(deps, request, (trx) => loadSettings(trx)),
  );

  r.put('/settings', { schema: { body: updateSettingsSchema }, config: { access } }, (request) =>
    inTenant(deps, request, async (trx) => {
      const before = await loadSettings(trx);
      const b = request.body;
      await trx
        .updateTable('tenants')
        .set({
          ...(b.name !== undefined && { name: b.name }),
          ...(b.defaultLocale !== undefined && { default_locale: b.defaultLocale }),
          ...(b.settings !== undefined && { settings: JSON.stringify(b.settings) }),
        })
        .execute();
      const after = await loadSettings(trx);
      await audit(
        trx,
        actorOf(request),
        {
          action: 'settings.change',
          entityType: 'tenant',
          entityId: request.auth?.tenantId ?? null,
          before,
          after,
        },
        deps.now(),
      );
      return after;
    }),
  );

  // Every signed-in user needs the currency list (selling, display).
  r.get('/currencies', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx) => loadCurrencies(trx)),
  );

  r.post(
    '/currencies',
    { schema: { body: createCurrencySchema }, config: { access } },
    async (request, reply) => {
      const currency = await inTenant(deps, request, async (trx, auth) => {
        const b = request.body;
        await trx
          .insertInto('tenant_currencies')
          .values({
            id: b.id,
            tenant_id: auth.tenantId,
            code: b.code,
            minor_units: b.minorUnits,
            cash_increment: b.cashIncrement ?? null,
            ...(b.sortOrder !== undefined && { sort_order: b.sortOrder }),
          })
          .execute();
        const [created] = await loadCurrencies(trx, b.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'currency.create', entityType: 'currency', entityId: b.id, after: created },
          deps.now(),
        );
        return created;
      });
      return reply.code(201).send(currency);
    },
  );

  r.patch(
    '/currencies/:id',
    { schema: { params: idParamsSchema, body: updateCurrencySchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const [before] = await loadCurrencies(trx, id);
        if (before === undefined) throw notFound();
        const b = request.body;
        await trx
          .updateTable('tenant_currencies')
          .set({
            ...(b.cashIncrement !== undefined && { cash_increment: b.cashIncrement }),
            ...(b.isActive !== undefined && { is_active: b.isActive }),
            ...(b.sortOrder !== undefined && { sort_order: b.sortOrder }),
          })
          .where('id', '=', id)
          .execute();
        const [after] = await loadCurrencies(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'currency.update', entityType: 'currency', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );
}
