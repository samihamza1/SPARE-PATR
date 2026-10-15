import { z } from 'zod';
import type { DecimalInput } from './decimal';
import { DECIMAL_PATTERN, dec, formatFixed, toDecimalString } from './decimal';
import type { CurrencySpec, Money } from './money';
import { CurrencyMismatchError, assertCurrencySpec } from './money';
import type { RoundingMode } from './rounding';
import { divideRounded, round } from './rounding';
import { currencyCodeSchema, decimalStringSchema } from './schemas';

/**
 * A market quote, stored as entered: 1 unit of `base` = `rate` units of `quote`
 * (e.g. 1 USD = 3.6725 AED). Converting from the quote currency divides exactly, so an
 * inverse rate is never rounded and stored (ADR 0019).
 */
export interface FxQuote {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
}

/** Most decimal places a quoted rate may have; matches the fx_rates column check. */
export const FX_RATE_MAX_SCALE = 10;
/** Most integer digits a quoted rate may have (e.g. 1 USD = 999,999,999,999 units). */
export const FX_RATE_MAX_INTEGER_DIGITS = 12;

function parseQuotedRate(rate: DecimalInput) {
  const r = dec(rate);
  if (r.lte(0)) throw new RangeError('FX rate must be positive');
  return r;
}

/**
 * Converts `m` into `to` using a quote between exactly those two currencies, rounding
 * once to the target's minor units. Multiplies from the base, divides from the quote.
 */
export function convertByQuote(m: Money, q: FxQuote, to: CurrencySpec, mode: RoundingMode): Money {
  assertCurrencySpec(to);
  const rate = parseQuotedRate(q.rate);
  let exact;
  if (m.currency === q.base && to.code === q.quote) {
    exact = round(dec(m.amount).times(rate), to.minorUnits, mode);
  } else if (m.currency === q.quote && to.code === q.base) {
    exact = divideRounded(m.amount, rate, to.minorUnits, mode);
  } else {
    throw new CurrencyMismatchError(
      `Quote ${q.base}/${q.quote} cannot convert ${m.currency} to ${to.code}`,
    );
  }
  return { amount: formatFixed(exact, to.minorUnits), currency: to.code };
}

/**
 * Invariant 2 with a quoted rate: the amount, its currency, the rate exactly as quoted
 * and which way it reads (1 fxBase = fxRate fxQuote), and the functional amount.
 */
export interface QuotedAmount {
  readonly amount: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxBase: string;
  readonly fxQuote: string;
  readonly functionalAmount: string;
}

/**
 * Builds the invariant-2 record for `m`. Amounts already in the functional currency take
 * rate 1 and need no quote; any other currency needs a quote between it and the
 * functional currency.
 */
export function toFunctionalByQuote(
  m: Money,
  q: FxQuote | null,
  functional: CurrencySpec,
  mode: RoundingMode,
): QuotedAmount {
  assertCurrencySpec(functional);
  if (m.currency === functional.code) {
    return {
      amount: m.amount,
      currency: m.currency,
      fxRate: '1',
      fxBase: functional.code,
      fxQuote: functional.code,
      functionalAmount: formatFixed(
        round(m.amount, functional.minorUnits, mode),
        functional.minorUnits,
      ),
    };
  }
  if (q === null) {
    throw new CurrencyMismatchError(
      `A rate is needed to convert ${m.currency} to ${functional.code}`,
    );
  }
  const converted = convertByQuote(m, q, functional, mode);
  return {
    amount: m.amount,
    currency: m.currency,
    fxRate: toDecimalString(parseQuotedRate(q.rate)),
    fxBase: q.base,
    fxQuote: q.quote,
    functionalAmount: converted.amount,
  };
}

/** A quoted rate: positive, at most 10 decimal places and 12 integer digits. */
export const quotedRateSchema = decimalStringSchema.refine(
  (s) => {
    // Zod runs refinements even when the pattern check failed: never parse malformed text.
    if (!DECIMAL_PATTERN.test(s)) return false;
    const r = dec(s);
    return (
      r.gt(0) &&
      r.decimalPlaces() <= FX_RATE_MAX_SCALE &&
      r.truncated().toFixed().length <= FX_RATE_MAX_INTEGER_DIGITS
    );
  },
  { message: 'Expected a positive rate with at most 10 decimal places' },
);

export const fxQuoteSchema = z
  .object({ base: currencyCodeSchema, quote: currencyCodeSchema, rate: quotedRateSchema })
  .refine((q) => q.base !== q.quote, {
    message: 'A rate needs two different currencies',
    path: ['quote'],
  });
