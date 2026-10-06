import type { CurrencySpec, FxQuote, Money, QuotedAmount } from '@autoparts/shared';
import { toFunctionalByQuote } from '@autoparts/shared';
import { sql } from 'kysely';
import { ApiError } from '../errors';
import type { Trx } from '../routes/common';
import type { MoneyContext } from '../tenant-settings';

export interface RecordedRate extends FxQuote {
  readonly id: string;
  readonly rateDate: string;
}

/**
 * The rate in effect on `date` (YYYY-MM-DD, tenant time zone) between the functional
 * currency and `currency`: the latest one dated on or before it, in either direction
 * (ADR 0019). A correction is a newer row for the same date, so recorded_at breaks ties.
 */
export async function rateInEffect(
  trx: Trx,
  functional: string,
  currency: string,
  date: string,
): Promise<RecordedRate | null> {
  const row = await trx
    .selectFrom('fx_rates')
    .select(['id', 'base_currency', 'quote_currency', 'rate', sql<string>`rate_date::text`.as('d')])
    .where((eb) =>
      eb.or([
        eb.and([eb('base_currency', '=', functional), eb('quote_currency', '=', currency)]),
        eb.and([eb('base_currency', '=', currency), eb('quote_currency', '=', functional)]),
      ]),
    )
    .where('rate_date', '<=', sql<Date>`${date}::date`)
    .orderBy('rate_date', 'desc')
    .orderBy('recorded_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    base: row.base_currency,
    quote: row.quote_currency,
    rate: row.rate,
    rateDate: row.d,
  };
}

/** Invariant 2 for one amount, with the id of the rate used (null in the functional currency). */
export type ValuedAmount = QuotedAmount & { readonly fxRateId: string | null };

/**
 * Values `m` in the functional currency with a given recorded rate, or rate 1 when it is
 * already in the functional currency. A missing rate is a 409 fx.rate_missing.
 */
export function valueAmount(
  m: Money,
  rate: RecordedRate | null,
  money: Pick<MoneyContext, 'functional' | 'roundingMode'>,
): ValuedAmount {
  if (m.currency === money.functional.code) {
    return {
      ...toFunctionalByQuote(m, null, money.functional, money.roundingMode),
      fxRateId: null,
    };
  }
  if (rate === null) throw new ApiError(409, 'fx.rate_missing');
  return {
    ...toFunctionalByQuote(m, rate, money.functional, money.roundingMode),
    fxRateId: rate.id,
  };
}

/** An amount already in the functional currency (rate 1). */
export function functionalAmount(amount: string, functional: CurrencySpec): ValuedAmount {
  return {
    amount,
    currency: functional.code,
    fxRate: '1',
    fxBase: functional.code,
    fxQuote: functional.code,
    functionalAmount: amount,
    fxRateId: null,
  };
}
