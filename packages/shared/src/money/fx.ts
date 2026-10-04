import { assertCurrencyCode, assertCurrencySpec } from './currency.js';
import type { CurrencyCode, CurrencySpec } from './currency.js';
import { fromDFixed, parseDecimal, toD } from './decimal.js';
import type { DecimalString, RoundingMode } from './decimal.js';
import type { Money } from './money.js';

/** 1 unit of `base` = `rate` units of `quote`. */
export interface FxRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: DecimalString;
}

/**
 * Invariant 2: every stored monetary amount keeps the transaction amount and currency,
 * the exact rate used (with its direction), and the amount in the functional currency.
 */
export interface MonetaryAmount {
  readonly amount: DecimalString;
  readonly currency: CurrencyCode;
  readonly fx: FxRate;
  readonly functionalAmount: DecimalString;
  readonly functionalCurrency: CurrencyCode;
}

export function fxRate(base: string, quote: string, rate: string): FxRate {
  assertCurrencyCode(base);
  assertCurrencyCode(quote);
  const r = parseDecimal(rate);
  const d = toD(r);
  if (!d.isPositive() || d.isZero()) throw new RangeError('FX rate must be positive');
  if (base === quote && !d.equals(1)) {
    throw new RangeError(`FX rate ${base}/${quote} must be 1`);
  }
  return { base, quote, rate: r };
}

export const identityRate = (code: string): FxRate => fxRate(code, code, '1');

/**
 * Convert `amount` into `target` using `rate` in either direction
 * (multiply when amount is in base, divide when it is in quote), then round
 * to the target's minor unit with the given mode.
 */
export function convert(
  amount: Money,
  rate: FxRate,
  target: CurrencySpec,
  mode: RoundingMode,
): Money {
  assertCurrencySpec(target);
  const value = toD(amount.amount);
  const r = toD(rate.rate);
  let exact;
  if (amount.currency === rate.base && target.code === rate.quote) {
    exact = value.times(r);
  } else if (amount.currency === rate.quote && target.code === rate.base) {
    exact = value.dividedBy(r);
  } else {
    throw new RangeError(
      `FX rate ${rate.base}/${rate.quote} cannot convert ${amount.currency} to ${target.code}`,
    );
  }
  return { amount: fromDFixed(exact, target.minorUnits, mode), currency: target.code };
}

export function toMonetaryAmount(
  amount: Money,
  rate: FxRate,
  functional: CurrencySpec,
  mode: RoundingMode,
): MonetaryAmount {
  const converted = convert(amount, rate, functional, mode);
  return {
    amount: amount.amount,
    currency: amount.currency,
    fx: rate,
    functionalAmount: converted.amount,
    functionalCurrency: converted.currency,
  };
}
