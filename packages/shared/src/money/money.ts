import type { DecimalInput } from './decimal';
import { Decimal, dec, formatFixed, shift, toBigInt, toDecimalString } from './decimal';
import type { RoundingMode } from './rounding';
import { MAX_SCALE, round, roundToIncrement } from './rounding';

/** An amount in one currency. `amount` is a decimal string, never a JS number. */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

/**
 * How a currency is rounded. Always supplied from tenant configuration: this package
 * deliberately contains no table of currencies, minor units or cash increments.
 */
export interface CurrencySpec {
  readonly code: string;
  readonly minorUnits: number;
  /** Smallest physical cash step, e.g. "0.05" or "250". Defaults to one minor unit. */
  readonly cashIncrement?: string;
}

/**
 * Invariant 2: every stored monetary amount carries its currency, the FX rate used
 * and the equivalent in the tenant's functional currency.
 */
export interface MonetaryAmount {
  readonly amount: string;
  readonly currency: string;
  /** Units of the functional currency per 1 unit of `currency`. */
  readonly fxRate: string;
  readonly functionalAmount: string;
}

export class CurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyMismatchError';
  }
}

export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function assertCurrencyCode(code: string): void {
  if (typeof code !== 'string' || !CURRENCY_CODE_PATTERN.test(code)) {
    throw new TypeError(`Malformed currency code: ${JSON.stringify(code)}`);
  }
}

function assertSameCurrency(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new CurrencyMismatchError(`Expected ${expected}, got ${actual}`);
  }
}

export function assertCurrencySpec(spec: CurrencySpec): void {
  assertCurrencyCode(spec.code);
  if (!Number.isInteger(spec.minorUnits) || spec.minorUnits < 0 || spec.minorUnits > MAX_SCALE) {
    throw new RangeError(`Invalid minorUnits for ${spec.code}`);
  }
  if (spec.cashIncrement !== undefined) {
    const inc = dec(spec.cashIncrement);
    if (inc.lte(0) || inc.decimalPlaces() > spec.minorUnits) {
      throw new RangeError(`Invalid cashIncrement for ${spec.code}`);
    }
  }
}

function minorUnit(spec: CurrencySpec): Decimal {
  return shift(new Decimal(1), -spec.minorUnits);
}

export function money(amount: DecimalInput, currency: string): Money {
  assertCurrencyCode(currency);
  return { amount: toDecimalString(dec(amount)), currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency);
  return money(dec(a.amount).plus(dec(b.amount)), a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency);
  return money(dec(a.amount).minus(dec(b.amount)), a.currency);
}

/** Multiplies by a decimal factor (e.g. a quantity). The result is not rounded. */
export function mul(a: Money, factor: DecimalInput): Money {
  return money(dec(a.amount).times(dec(factor)), a.currency);
}

export function neg(a: Money): Money {
  return money(dec(a.amount).neg(), a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a.currency, b.currency);
  return dec(a.amount).comparedTo(dec(b.amount)) as -1 | 0 | 1;
}

export function isZero(a: Money): boolean {
  return dec(a.amount).isZero();
}

export function sum(currency: string, items: readonly Money[]): Money {
  return items.reduce((acc, item) => add(acc, item), money('0', currency));
}

/** Rounds to the currency's minor units; the amount string has exactly that many decimals. */
export function roundMoney(m: Money, spec: CurrencySpec, mode: RoundingMode): Money {
  assertCurrencySpec(spec);
  assertSameCurrency(spec.code, m.currency);
  return {
    amount: formatFixed(round(m.amount, spec.minorUnits, mode), spec.minorUnits),
    currency: m.currency,
  };
}

/** Rounds to the currency's cash increment (or one minor unit if none is configured). */
export function roundCash(m: Money, spec: CurrencySpec, mode: RoundingMode): Money {
  assertCurrencySpec(spec);
  assertSameCurrency(spec.code, m.currency);
  const increment = spec.cashIncrement ?? minorUnit(spec);
  return {
    amount: formatFixed(roundToIncrement(m.amount, increment, mode), spec.minorUnits),
    currency: m.currency,
  };
}

function parseRate(rate: DecimalInput): Decimal {
  const r = dec(rate);
  if (r.lte(0)) throw new RangeError('FX rate must be positive');
  return r;
}

/**
 * Converts into `to` at `rate` = units of `to` per 1 unit of `m.currency`, rounding the
 * result to the target currency's minor units. The rate itself is never rounded.
 */
export function convert(m: Money, rate: DecimalInput, to: CurrencySpec, mode: RoundingMode): Money {
  assertCurrencySpec(to);
  const r = parseRate(rate);
  if (m.currency === to.code && !r.eq(1)) {
    throw new CurrencyMismatchError(`Converting ${m.currency} to itself requires rate 1`);
  }
  const exact = dec(m.amount).times(r);
  return {
    amount: formatFixed(round(exact, to.minorUnits, mode), to.minorUnits),
    currency: to.code,
  };
}

/** Builds the full invariant-2 record for an amount, given the functional currency spec. */
export function toFunctional(
  m: Money,
  rate: DecimalInput,
  functional: CurrencySpec,
  mode: RoundingMode,
): MonetaryAmount {
  const converted = convert(m, rate, functional, mode);
  return {
    amount: m.amount,
    currency: m.currency,
    fxRate: toDecimalString(parseRate(rate)),
    functionalAmount: converted.amount,
  };
}

/**
 * Splits `total` in proportion to `weights` so that the parts always sum exactly to the
 * total (largest-remainder method; ties go to the earliest index, so it is deterministic).
 * The total must already be rounded to the currency's minor units.
 */
export function allocate(
  total: Money,
  weights: readonly DecimalInput[],
  spec: CurrencySpec,
): Money[] {
  assertCurrencySpec(spec);
  assertSameCurrency(spec.code, total.currency);
  if (weights.length === 0) throw new RangeError('allocate needs at least one weight');

  const t = dec(total.amount);
  if (t.decimalPlaces() > spec.minorUnits) {
    throw new RangeError('Round the total to the currency minor units before allocating');
  }
  const ws = weights.map((w) => dec(w));
  if (ws.some((w) => w.lt(0))) throw new RangeError('Weights must not be negative');

  const weightScale = Math.max(...ws.map((w) => w.decimalPlaces()));
  const intWeights = ws.map((w) => toBigInt(shift(w, weightScale)));
  const weightSum = intWeights.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) throw new RangeError('At least one weight must be positive');

  const units = toBigInt(shift(t, spec.minorUnits));
  const negative = units < 0n;
  const absUnits = negative ? -units : units;

  const shares = intWeights.map((w) => (absUnits * w) / weightSum);
  const remainders = intWeights.map((w) => (absUnits * w) % weightSum);
  let leftover = absUnits - shares.reduce((acc, s) => acc + s, 0n);

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (leftover === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return shares.map((share) => ({
    amount: formatFixed(
      shift(new Decimal((negative ? -share : share).toString()), -spec.minorUnits),
      spec.minorUnits,
    ),
    currency: total.currency,
  }));
}
