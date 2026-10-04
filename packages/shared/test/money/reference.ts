/**
 * Independent BigInt reference implementation used as a test oracle.
 * It shares no code with the production money utilities on purpose.
 */
import fc from 'fast-check';

import type { RoundingMode } from '../../src/money/index.js';

export interface Fixed {
  /** Unscaled integer value. */
  readonly units: bigint;
  /** Number of decimal places. */
  readonly scale: number;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

export function toFixedString({ units, scale }: Fixed): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  const body = scale === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative && units !== 0n ? `-${body}` : body;
}

export function parseFixed(value: string): Fixed {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [intPart = '', fracPart = ''] = body.split('.');
  const units = BigInt(intPart + fracPart);
  return { units: negative ? -units : units, scale: fracPart.length };
}

export function rescale(value: Fixed, scale: number): bigint {
  if (scale < value.scale) throw new Error('rescale would lose precision');
  return value.units * pow10(scale - value.scale);
}

/** Round a fixed-point value to `dp` decimal places with the given mode. */
export function refRound(value: Fixed, dp: number, mode: RoundingMode): Fixed {
  if (value.scale <= dp) return { units: rescale(value, dp), scale: dp };
  const divisor = pow10(value.scale - dp);
  const negative = value.units < 0n;
  const abs = negative ? -value.units : value.units;
  const q = abs / divisor;
  const r = abs % divisor;
  const twice = r * 2n;
  let up: boolean;
  switch (mode) {
    case 'DOWN':
      up = false;
      break;
    case 'UP':
      up = r !== 0n;
      break;
    case 'HALF_UP':
      up = twice >= divisor;
      break;
    case 'HALF_DOWN':
      up = twice > divisor;
      break;
    case 'HALF_EVEN':
      up = twice > divisor || (twice === divisor && q % 2n === 1n);
      break;
  }
  const rounded = up ? q + 1n : q;
  return { units: negative ? -rounded : rounded, scale: dp };
}

export const roundingModes: readonly RoundingMode[] = [
  'HALF_UP',
  'HALF_DOWN',
  'HALF_EVEN',
  'UP',
  'DOWN',
];

export const arbMode = fc.constantFrom(...roundingModes);

/**
 * Arbitrary decimal as a fixed-point value (up to 26 digits, up to `maxScale` decimals).
 * Small values are mixed in so that exact ties (…5) are frequent enough to exercise
 * HALF_* tie-breaking, and an explicit tie generator is included.
 */
export const arbFixed = (maxScale = 8): fc.Arbitrary<Fixed> =>
  fc.oneof(
    fc.record({
      units: fc.bigInt({ min: -(10n ** 26n), max: 10n ** 26n }),
      scale: fc.integer({ min: 0, max: maxScale }),
    }),
    fc.record({
      units: fc.bigInt({ min: -2000n, max: 2000n }),
      scale: fc.integer({ min: 0, max: maxScale }),
    }),
    arbTie(maxScale),
  );

/** Values that sit exactly halfway between two neighbours at some decimal place. */
export const arbTie = (maxScale = 8): fc.Arbitrary<Fixed> =>
  fc
    .record({
      q: fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
      scale: fc.integer({ min: 1, max: Math.max(1, maxScale) }),
    })
    .map(({ q, scale }) => ({ units: q * 10n + (q < 0n ? -5n : 5n), scale }));

export const arbDecimalString = (maxScale = 8): fc.Arbitrary<string> =>
  arbFixed(maxScale).map(toFixedString);

export const arbMinorUnits = fc.integer({ min: 0, max: 4 });
