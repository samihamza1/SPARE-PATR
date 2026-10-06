import type { CurrencySpec, RoundingMode } from '@autoparts/shared';
import { inventorySettingsSchema, moneySettingsSchema } from '@autoparts/shared';
import { ApiError } from './errors';
import type { Trx } from './routes/common';

/**
 * Each module reads only its own part of the tenant settings (ADR 0022). A business rule
 * that was never chosen is a 409 settings.incomplete, never a silent default.
 */
const incomplete = () => new ApiError(409, 'settings.incomplete');

export interface MoneyContext {
  readonly functional: CurrencySpec;
  readonly roundingMode: RoundingMode;
  readonly timezone: string;
}

export async function readMoneySettings(trx: Trx): Promise<MoneyContext> {
  const t = await trx
    .selectFrom('tenants as t')
    .innerJoin('tenant_currencies as c', (j) =>
      j.onRef('c.tenant_id', '=', 't.id').onRef('c.code', '=', 't.functional_currency'),
    )
    .select(['t.functional_currency', 't.timezone', 't.settings', 'c.minor_units'])
    .executeTakeFirstOrThrow();
  const money = moneySettingsSchema.safeParse((t.settings as { money?: unknown }).money);
  if (!money.success) throw incomplete();
  return {
    functional: { code: t.functional_currency, minorUnits: t.minor_units },
    roundingMode: money.data.roundingMode,
    timezone: t.timezone,
  };
}

export async function readInventorySettings(trx: Trx): Promise<{ allowNegativeStock: boolean }> {
  const t = await trx.selectFrom('tenants').select('settings').executeTakeFirstOrThrow();
  const inventory = inventorySettingsSchema.safeParse(
    (t.settings as { inventory?: unknown }).inventory,
  );
  if (!inventory.success) throw incomplete();
  return inventory.data;
}
