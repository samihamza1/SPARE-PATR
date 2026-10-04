import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CurrencySpec } from '../../src/money/index.js';
import { parseDecimal, round, roundTo, roundToIncrement } from '../../src/money/index.js';
import {
  arbDecimalString,
  arbFixed,
  arbMinorUnits,
  arbMode,
  arbTie,
  parseFixed,
  refRound,
  rescale,
  toFixedString,
} from './reference.js';

// Test-only spec. Real specs come from per-tenant configuration.
const spec = (minorUnits: number): CurrencySpec => ({ code: 'XTS', minorUnits });

describe('round', () => {
  it('matches the BigInt oracle for every mode and minor-unit count', () => {
    fc.assert(
      fc.property(arbFixed(), arbMinorUnits, arbMode, (value, mu, mode) => {
        const expected = toFixedString(refRound(value, mu, mode));
        expect(round(parseDecimal(toFixedString(value)), spec(mu), mode)).toBe(expected);
      }),
    );
  });

  it('breaks exact ties per mode: HALF_EVEN to even, HALF_UP away from zero, HALF_DOWN toward zero', () => {
    fc.assert(
      fc.property(arbTie(5), (tie) => {
        const value = parseDecimal(toFixedString(tie));
        const mu = tie.scale - 1;
        const even = parseFixed(round(value, spec(mu), 'HALF_EVEN')).units;
        const up = parseFixed(round(value, spec(mu), 'HALF_UP')).units;
        const down = parseFixed(round(value, spec(mu), 'HALF_DOWN')).units;
        const absUp = up < 0n ? -up : up;
        const absDown = down < 0n ? -down : down;
        expect(even % 2n).toBe(0n);
        expect(absUp - absDown).toBe(1n);
        expect([up, down]).toContain(even);
      }),
    );
  });

  it('always yields exactly minorUnits decimal places', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbMinorUnits, arbMode, (a, mu, mode) => {
        expect(parseFixed(round(parseDecimal(a), spec(mu), mode)).scale).toBe(mu);
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbMinorUnits, arbMode, arbMode, (a, mu, m1, m2) => {
        const once = round(parseDecimal(a), spec(mu), m1);
        expect(round(once, spec(mu), m2)).toBe(once);
      }),
    );
  });

  it('error is at most half a unit for HALF_* modes and below one unit otherwise', () => {
    fc.assert(
      fc.property(arbFixed(), arbMinorUnits, arbMode, (value, mu, mode) => {
        const rounded = parseFixed(round(parseDecimal(toFixedString(value)), spec(mu), mode));
        const scale = Math.max(value.scale, mu);
        const err = rescale(rounded, scale) - rescale(value, scale);
        const absErr2 = (err < 0n ? -err : err) * 2n;
        const unit = 10n ** BigInt(scale - mu);
        if (mode.startsWith('HALF_')) expect(absErr2 <= unit).toBe(true);
        else expect(absErr2 < unit * 2n).toBe(true);
      }),
    );
  });

  it('is symmetric around zero', () => {
    fc.assert(
      fc.property(arbFixed(), arbMinorUnits, arbMode, (value, mu, mode) => {
        const pos = round(parseDecimal(toFixedString(value)), spec(mu), mode);
        const neg = round(
          parseDecimal(toFixedString({ units: -value.units, scale: value.scale })),
          spec(mu),
          mode,
        );
        expect(parseFixed(neg).units).toBe(-parseFixed(pos).units);
      }),
    );
  });

  it.each([
    ['2.345', 2, 'HALF_EVEN', '2.34'],
    ['2.355', 2, 'HALF_EVEN', '2.36'],
    ['2.345', 2, 'HALF_UP', '2.35'],
    ['2.345', 2, 'HALF_DOWN', '2.34'],
    ['-2.345', 2, 'HALF_UP', '-2.35'],
    ['2.341', 2, 'UP', '2.35'],
    ['2.349', 2, 'DOWN', '2.34'],
    ['-0.004', 2, 'HALF_UP', '0.00'],
    ['1', 3, 'HALF_UP', '1.000'],
    ['0.5', 0, 'HALF_EVEN', '0'],
    ['1.5', 0, 'HALF_EVEN', '2'],
  ] as const)('round(%s, %i, %s) = %s', (value, mu, mode, expected) => {
    expect(round(parseDecimal(value), spec(mu), mode)).toBe(expected);
  });

  it('rejects invalid currency specs', () => {
    expect(() => round(parseDecimal('1'), spec(-1), 'HALF_UP')).toThrow();
    expect(() => round(parseDecimal('1'), spec(1.5), 'HALF_UP')).toThrow();
    expect(() => round(parseDecimal('1'), { code: 'bad', minorUnits: 2 }, 'HALF_UP')).toThrow();
  });
});

describe('roundTo', () => {
  it('rounds to an arbitrary number of decimal places', () => {
    expect(roundTo(parseDecimal('1.23456'), 3, 'HALF_UP')).toBe('1.235');
    expect(() => roundTo(parseDecimal('1'), -1, 'HALF_UP')).toThrow(RangeError);
  });
});

describe('roundToIncrement (cash rounding)', () => {
  it.each([
    ['1.02', '0.05', 'HALF_UP', '1.00'],
    ['1.025', '0.05', 'HALF_UP', '1.05'],
    ['1.03', '0.05', 'DOWN', '1.00'],
    ['1.01', '0.05', 'UP', '1.05'],
    ['17', '5', 'HALF_EVEN', '15'],
    ['18', '5', 'HALF_EVEN', '20'],
    ['-1.03', '0.05', 'HALF_UP', '-1.05'],
  ] as const)('roundToIncrement(%s, %s, %s) = %s', (value, inc, mode, expected) => {
    expect(roundToIncrement(parseDecimal(value), parseDecimal(inc), mode)).toBe(expected);
  });

  it('yields a multiple of the increment within one increment of the input', () => {
    const arbIncrement = fc
      .record({ units: fc.bigInt({ min: 1n, max: 1000n }), scale: fc.integer({ min: 0, max: 3 }) })
      .map(toFixedString);
    fc.assert(
      fc.property(arbDecimalString(4), arbIncrement, arbMode, (a, inc, mode) => {
        const result = parseFixed(roundToIncrement(parseDecimal(a), parseDecimal(inc), mode));
        const fi = parseFixed(inc);
        const fa = parseFixed(a);
        const scale = Math.max(result.scale, fi.scale, fa.scale);
        const r = rescale(result, scale);
        const i = rescale(fi, scale);
        const v = rescale(fa, scale);
        expect(r % i).toBe(0n);
        const diff = r - v;
        expect((diff < 0n ? -diff : diff) < i).toBe(true);
      }),
    );
  });

  it('rejects non-positive increments', () => {
    expect(() => roundToIncrement(parseDecimal('1'), parseDecimal('0'), 'HALF_UP')).toThrow(
      RangeError,
    );
    expect(() => roundToIncrement(parseDecimal('1'), parseDecimal('-0.05'), 'HALF_UP')).toThrow(
      RangeError,
    );
  });
});
