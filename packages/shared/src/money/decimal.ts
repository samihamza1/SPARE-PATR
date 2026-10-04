import { Decimal as DecimalJs } from 'decimal.js';

/**
 * Isolated decimal.js constructor for money and FX maths. Never mutate the global
 * decimal.js config and never use JS numbers for money (invariant 1).
 *
 * Precision is in significant digits: 64 keeps products of realistic amounts and FX
 * rates exact. Exponent thresholds are pushed out so strings never use "1e-7" notation.
 */
export const Decimal = DecimalJs.clone({
  precision: 64,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});
export type Decimal = DecimalJs;

/** A decimal value as it travels through JSON and the API: a string, never a JS number. */
export type DecimalInput = string | Decimal;

/** Canonical decimal string: optional minus, no leading zeros, no exponent, no "+". */
export const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Parses a decimal string. Rejects JS numbers at runtime as well as at compile time. */
export function dec(value: DecimalInput): Decimal {
  if (Decimal.isDecimal(value)) {
    if (!value.isFinite()) throw new TypeError('Decimal value must be finite');
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a decimal string, got ${typeof value}`);
  }
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Malformed decimal string: ${JSON.stringify(value)}`);
  }
  return new Decimal(value);
}

/** Serialises without exponent notation or trailing zeros; negative zero becomes "0". */
export function toDecimalString(value: Decimal): string {
  return value.isZero() ? '0' : value.toFixed();
}

/** Serialises with exactly `scale` decimal places. Throws instead of rounding silently. */
export function formatFixed(value: Decimal, scale: number): string {
  if (value.decimalPlaces() > scale) {
    throw new RangeError(`${value.toFixed()} has more than ${String(scale)} decimal places`);
  }
  return (value.isZero() ? new Decimal(0) : value).toFixed(scale);
}

/** Converts an integral decimal to a bigint for exact integer arithmetic. */
export function toBigInt(value: Decimal): bigint {
  if (!value.isInteger()) throw new RangeError(`${value.toFixed()} is not an integer`);
  return BigInt(value.toFixed(0));
}

/** Multiplies by 10^places (exact: powers of ten have a single significant digit). */
export function shift(value: Decimal, places: number): Decimal {
  return value.times(Decimal.pow(10, places));
}
