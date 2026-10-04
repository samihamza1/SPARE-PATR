import Decimal from 'decimal.js';

/**
 * A validated, canonical decimal number encoded as a string (e.g. "-12.50").
 * This is the only representation of money and FX rates that crosses module,
 * JSON and database boundaries. JS numbers are never accepted.
 */
export type DecimalString = string & { readonly __brand: 'DecimalString' };

export type RoundingMode = 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN' | 'UP' | 'DOWN';

/** Upper bound on digits accepted by parseDecimal; keeps arithmetic exact well within precision. */
export const MAX_DIGITS = 100;

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Isolated decimal.js constructor. Precision is far above MAX_DIGITS * 2 so that
 * add, sub and mul of accepted inputs are exact; division always takes an explicit
 * scale and rounding mode. Exponent notation is disabled for string output.
 */
export const D = Decimal.clone({
  precision: 1000,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});
export type D = InstanceType<typeof D>;

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_DOWN: Decimal.ROUND_HALF_DOWN,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
};

export function toRounding(mode: RoundingMode): Decimal.Rounding {
  const rounding = MODES[mode] as Decimal.Rounding | undefined;
  if (rounding === undefined)
    throw new RangeError(`Unknown rounding mode: ${JSON.stringify(mode)}`);
  return rounding;
}

export function isDecimalString(value: unknown): value is DecimalString {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return false;
  return value.replace(/[-.]/g, '').length <= MAX_DIGITS;
}

/** Parse a strict decimal string ("-12.50"). Rejects numbers, exponents, whitespace, "+", ".5". */
export function parseDecimal(value: string): DecimalString {
  if (typeof value !== 'string') {
    throw new TypeError(`Decimal values must be strings, got ${typeof value}`);
  }
  if (!isDecimalString(value))
    throw new RangeError(`Invalid decimal string: ${JSON.stringify(value)}`);
  return fromD(new D(value));
}

/** Internal: wrap a decimal.js value. Callers must not leak D outside the money module. */
export function toD(value: DecimalString): D {
  return new D(value);
}

/** Internal: canonical string (no exponent, no negative zero, trailing zeros trimmed). */
export function fromD(value: D): DecimalString {
  if (!value.isFinite()) throw new RangeError('Decimal result is not finite');
  return (value.isZero() ? '0' : value.toString()) as DecimalString;
}

/** Internal: fixed-scale string (keeps trailing zeros, no negative zero). */
export function fromDFixed(value: D, scale: number, mode: RoundingMode): DecimalString {
  const rounded = value.toDecimalPlaces(scale, toRounding(mode));
  const abs = rounded.abs();
  // eslint-disable-next-line no-restricted-properties -- decimal.js toFixed is exact, not Number#toFixed
  const body = abs.toFixed(scale);
  return (rounded.isNegative() && !rounded.isZero() ? `-${body}` : body) as DecimalString;
}

export function assertScale(scale: number, name = 'scale'): void {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(scale)}`);
  }
}

export const add = (a: DecimalString, b: DecimalString): DecimalString =>
  fromD(toD(a).plus(toD(b)));
export const sub = (a: DecimalString, b: DecimalString): DecimalString =>
  fromD(toD(a).minus(toD(b)));
export const mul = (a: DecimalString, b: DecimalString): DecimalString =>
  fromD(toD(a).times(toD(b)));
export const negate = (a: DecimalString): DecimalString => fromD(toD(a).negated());
export const abs = (a: DecimalString): DecimalString => fromD(toD(a).abs());
export const isZero = (a: DecimalString): boolean => toD(a).isZero();
export const isNegative = (a: DecimalString): boolean => toD(a).isNegative() && !toD(a).isZero();
export const isPositive = (a: DecimalString): boolean => toD(a).isPositive() && !toD(a).isZero();

export function sum(values: readonly DecimalString[]): DecimalString {
  return fromD(values.reduce((acc, v) => acc.plus(toD(v)), new D(0)));
}

/** -1, 0 or 1. */
export function compare(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return toD(a).comparedTo(toD(b)) as -1 | 0 | 1;
}

/** Division always rounds to an explicit number of decimal places with an explicit mode. */
export function div(
  a: DecimalString,
  b: DecimalString,
  scale: number,
  mode: RoundingMode,
): DecimalString {
  assertScale(scale);
  const divisor = toD(b);
  if (divisor.isZero()) throw new RangeError('Division by zero');
  return fromDFixed(toD(a).dividedBy(divisor), scale, mode);
}
