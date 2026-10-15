import { Decimal as DecimalJs } from 'decimal.js';
import type { DecimalInput } from './decimal';
import { Decimal, dec, shift, toBigInt } from './decimal';

/**
 * Supported rounding modes. Which one applies (and where) is tenant configuration;
 * this module never picks one on the caller's behalf.
 *
 * HALF_UP / HALF_DOWN: ties go away from / towards zero.
 * HALF_EVEN: ties go to the even neighbour (banker's rounding).
 * UP / DOWN: away from / towards zero. CEIL / FLOOR: towards +inf / -inf.
 */
export const ROUNDING_MODES = [
  'HALF_UP',
  'HALF_DOWN',
  'HALF_EVEN',
  'UP',
  'DOWN',
  'CEIL',
  'FLOOR',
] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

const DECIMAL_JS_MODE: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: DecimalJs.ROUND_HALF_UP,
  HALF_DOWN: DecimalJs.ROUND_HALF_DOWN,
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN,
  UP: DecimalJs.ROUND_UP,
  DOWN: DecimalJs.ROUND_DOWN,
  CEIL: DecimalJs.ROUND_CEIL,
  FLOOR: DecimalJs.ROUND_FLOOR,
};

/** Upper bound on decimal places we round to; a sanity check, not a currency rule. */
export const MAX_SCALE = 18;

export function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`Scale must be an integer between 0 and ${String(MAX_SCALE)}`);
  }
}

/** Rounds to `scale` decimal places. */
export function round(value: DecimalInput, scale: number, mode: RoundingMode): Decimal {
  assertScale(scale);
  return dec(value).toDecimalPlaces(scale, DECIMAL_JS_MODE[mode]);
}

/**
 * Rounds to the nearest multiple of `increment` (cash rounding, e.g. 0.05 or 250).
 * Computed with exact integer arithmetic, so non-terminating quotients such as
 * x / 0.03 are rounded correctly.
 */
export function roundToIncrement(
  value: DecimalInput,
  increment: DecimalInput,
  mode: RoundingMode,
): Decimal {
  const x = dec(value);
  const inc = dec(increment);
  if (inc.lte(0)) throw new RangeError('Rounding increment must be positive');
  const scale = Math.max(x.decimalPlaces(), inc.decimalPlaces());
  const quotient = roundQuotient(toBigInt(shift(x, scale)), toBigInt(shift(inc, scale)), mode);
  return new Decimal(quotient.toString()).times(inc);
}

/** Rounds the rational n / d (d > 0) to an integer. */
export function roundQuotient(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) throw new RangeError('Denominator must be positive');
  const q = n / d; // truncates towards zero
  const r = n % d; // has the sign of n
  if (r === 0n) return q;
  const away = q + (n < 0n ? -1n : 1n);
  const twiceRemainder = 2n * (r < 0n ? -r : r);
  const vsHalf = twiceRemainder === d ? 0 : twiceRemainder > d ? 1 : -1;
  switch (mode) {
    case 'DOWN':
      return q;
    case 'UP':
      return away;
    case 'CEIL':
      return n > 0n ? away : q;
    case 'FLOOR':
      return n < 0n ? away : q;
    case 'HALF_UP':
      return vsHalf >= 0 ? away : q;
    case 'HALF_DOWN':
      return vsHalf > 0 ? away : q;
    case 'HALF_EVEN':
      if (vsHalf !== 0) return vsHalf > 0 ? away : q;
      return q % 2n === 0n ? q : away;
  }
}
