import fc from 'fast-check';
import type { RoundingMode } from '../../src/money';
import { ROUNDING_MODES } from '../../src/money';

export const HALF_MODES: readonly RoundingMode[] = ['HALF_UP', 'HALF_DOWN', 'HALF_EVEN'];
export const DIRECTED_MODES: readonly RoundingMode[] = ['UP', 'DOWN', 'CEIL', 'FLOOR'];

export const roundingModeArb = fc.constantFrom(...ROUNDING_MODES);

/** Builds a canonical decimal string from an integer number of units and a scale. */
export function unitsToDecimalString(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative && units !== 0n ? `-${body}` : body;
}

export interface DecimalArbOptions {
  maxScale?: number;
  maxUnits?: bigint;
  allowNegative?: boolean;
}

/** Arbitrary decimal strings such as "-1234.0567", never in exponent notation. */
export function decimalArb(options: DecimalArbOptions = {}): fc.Arbitrary<string> {
  const { maxScale = 8, maxUnits = 10n ** 15n, allowNegative = true } = options;
  return fc
    .tuple(
      fc.bigInt({ min: allowNegative ? -maxUnits : 0n, max: maxUnits }),
      fc.integer({ min: 0, max: maxScale }),
    )
    .map(([units, scale]) => unitsToDecimalString(units, scale));
}

/** Arbitrary decimal strings with exactly `scale` decimal places (an amount already at currency scale). */
export function scaledDecimalArb(
  scale: number,
  options: Omit<DecimalArbOptions, 'maxScale'> = {},
): fc.Arbitrary<string> {
  const { maxUnits = 10n ** 15n, allowNegative = true } = options;
  return fc
    .bigInt({ min: allowNegative ? -maxUnits : 0n, max: maxUnits })
    .map((units) => unitsToDecimalString(units, scale));
}

/** Strictly positive decimal strings, e.g. FX rates or weights. */
export function positiveDecimalArb(maxScale = 10): fc.Arbitrary<string> {
  return fc
    .tuple(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 0, max: maxScale }))
    .map(([units, scale]) => unitsToDecimalString(units, scale));
}

/** Currency minor units used in tests; real values always come from tenant configuration. */
export const minorUnitsArb = fc.integer({ min: 0, max: 4 });
