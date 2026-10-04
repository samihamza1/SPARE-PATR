import { assertCurrencySpec } from './currency.js';
import type { CurrencySpec } from './currency.js';
import { assertScale, fromDFixed, toD, toRounding } from './decimal.js';
import type { DecimalString, RoundingMode } from './decimal.js';

/** Round to an explicit number of decimal places; output always has exactly `scale` places. */
export function roundTo(value: DecimalString, scale: number, mode: RoundingMode): DecimalString {
  assertScale(scale);
  return fromDFixed(toD(value), scale, mode);
}

/** Round to the currency's minor unit. The mode is required: it is a per-tenant decision. */
export function round(value: DecimalString, spec: CurrencySpec, mode: RoundingMode): DecimalString {
  assertCurrencySpec(spec);
  return roundTo(value, spec.minorUnits, mode);
}

/**
 * Round to a multiple of `increment` (cash rounding, e.g. to the smallest coin).
 * Output has the same number of decimal places as the increment.
 */
export function roundToIncrement(
  value: DecimalString,
  increment: DecimalString,
  mode: RoundingMode,
): DecimalString {
  const inc = toD(increment);
  if (!inc.isPositive() || inc.isZero()) throw new RangeError('Increment must be positive');
  const steps = toD(value).dividedBy(inc).toDecimalPlaces(0, toRounding(mode));
  return fromDFixed(steps.times(inc), inc.decimalPlaces(), mode);
}
