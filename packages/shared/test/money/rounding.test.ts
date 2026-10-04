import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RoundingMode } from '../../src/money';
import { dec, round, roundToIncrement, shift } from '../../src/money';
import {
  DIRECTED_MODES,
  HALF_MODES,
  decimalArb,
  positiveDecimalArb,
  roundingModeArb,
} from './arbitraries';

const scaleArb = fc.integer({ min: 0, max: 6 });
const unit = (scale: number) => shift(dec('1'), -scale);

describe('round: golden cases', () => {
  const cases: [string, number, RoundingMode, string][] = [
    ['2.5', 0, 'HALF_UP', '3'],
    ['2.5', 0, 'HALF_DOWN', '2'],
    ['2.5', 0, 'HALF_EVEN', '2'],
    ['3.5', 0, 'HALF_EVEN', '4'],
    ['-2.5', 0, 'HALF_UP', '-3'],
    ['-2.5', 0, 'HALF_DOWN', '-2'],
    ['-2.5', 0, 'HALF_EVEN', '-2'],
    ['1.005', 2, 'HALF_UP', '1.01'],
    ['1.005', 2, 'HALF_EVEN', '1'],
    ['1.2345', 3, 'HALF_UP', '1.235'],
    ['1.2345', 3, 'HALF_EVEN', '1.234'],
    ['1234.5', 0, 'HALF_UP', '1235'],
    ['1.001', 2, 'UP', '1.01'],
    ['-1.001', 2, 'UP', '-1.01'],
    ['1.009', 2, 'DOWN', '1'],
    ['-1.009', 2, 'DOWN', '-1'],
    ['-1.001', 2, 'CEIL', '-1'],
    ['-1.001', 2, 'FLOOR', '-1.01'],
    ['0.1', 0, 'HALF_UP', '0'],
  ];

  it.each(cases)('round(%s, %i, %s) = %s', (value, scale, mode, expected) => {
    expect(round(dec(value), scale, mode).eq(dec(expected))).toBe(true);
  });

  it('rejects invalid scales', () => {
    expect(() => round(dec('1'), -1, 'HALF_UP')).toThrow(RangeError);
    expect(() => round(dec('1'), 1.5, 'HALF_UP')).toThrow(RangeError);
  });
});

describe('round: properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, roundingModeArb, (s, scale, mode) => {
        const once = round(dec(s), scale, mode);
        expect(round(once, scale, mode).eq(once)).toBe(true);
      }),
    );
  });

  it('never leaves more decimal places than the scale', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, roundingModeArb, (s, scale, mode) => {
        expect(round(dec(s), scale, mode).decimalPlaces()).toBeLessThanOrEqual(scale);
      }),
    );
  });

  it('leaves values already at the scale unchanged', () => {
    fc.assert(
      fc.property(decimalArb({ maxScale: 3 }), roundingModeArb, (s, mode) => {
        expect(round(dec(s), 3, mode).eq(dec(s))).toBe(true);
      }),
    );
  });

  it('half modes err by at most half a unit', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, fc.constantFrom(...HALF_MODES), (s, scale, mode) => {
        const x = dec(s);
        const error = round(x, scale, mode).minus(x).abs();
        expect(error.lte(unit(scale).div(2))).toBe(true);
      }),
    );
  });

  it('directed modes err by less than one unit, in the documented direction', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, fc.constantFrom(...DIRECTED_MODES), (s, scale, mode) => {
        const x = dec(s);
        const r = round(x, scale, mode);
        expect(r.minus(x).abs().lt(unit(scale))).toBe(true);
        if (mode === 'UP') expect(r.abs().gte(x.abs())).toBe(true);
        if (mode === 'DOWN') expect(r.abs().lte(x.abs())).toBe(true);
        if (mode === 'CEIL') expect(r.gte(x)).toBe(true);
        if (mode === 'FLOOR') expect(r.lte(x)).toBe(true);
      }),
    );
  });

  it('HALF_UP and HALF_EVEN only disagree on exact ties', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, (s, scale) => {
        const x = dec(s);
        const a = round(x, scale, 'HALF_UP');
        const b = round(x, scale, 'HALF_EVEN');
        if (!a.eq(b)) {
          const fraction = shift(x, scale).abs().mod(1);
          expect(fraction.eq(dec('0.5'))).toBe(true);
        }
      }),
    );
  });

  it('half modes are symmetric around zero', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, fc.constantFrom(...HALF_MODES), (s, scale, mode) => {
        const x = dec(s);
        expect(round(x.neg(), scale, mode).eq(round(x, scale, mode).neg())).toBe(true);
      }),
    );
  });

  it('agrees with roundToIncrement(10^-scale), cross-checking both implementations', () => {
    fc.assert(
      fc.property(decimalArb(), scaleArb, roundingModeArb, (s, scale, mode) => {
        const x = dec(s);
        expect(round(x, scale, mode).eq(roundToIncrement(x, unit(scale), mode))).toBe(true);
      }),
    );
  });
});

describe('roundToIncrement (cash rounding)', () => {
  const cases: [string, string, RoundingMode, string][] = [
    ['1.12', '0.05', 'HALF_UP', '1.1'],
    ['1.13', '0.05', 'HALF_UP', '1.15'],
    ['1.125', '0.05', 'HALF_UP', '1.15'],
    ['1.125', '0.05', 'HALF_DOWN', '1.1'],
    ['1125', '250', 'HALF_UP', '1250'],
    ['1125', '250', 'HALF_EVEN', '1000'],
    ['1375', '250', 'HALF_EVEN', '1500'],
    ['-1125', '250', 'HALF_UP', '-1250'],
    ['1001', '250', 'CEIL', '1250'],
    ['1249', '250', 'FLOOR', '1000'],
    ['0.10', '0.03', 'HALF_UP', '0.09'],
  ];

  it.each(cases)('roundToIncrement(%s, %s, %s) = %s', (value, increment, mode, expected) => {
    expect(roundToIncrement(dec(value), dec(increment), mode).eq(dec(expected))).toBe(true);
  });

  it('rejects non-positive increments', () => {
    expect(() => roundToIncrement(dec('1'), dec('0'), 'HALF_UP')).toThrow(RangeError);
    expect(() => roundToIncrement(dec('1'), dec('-0.05'), 'HALF_UP')).toThrow(RangeError);
  });

  it('always yields an exact multiple of the increment, within the error bound', () => {
    fc.assert(
      fc.property(decimalArb(), positiveDecimalArb(3), roundingModeArb, (s, inc, mode) => {
        const x = dec(s);
        const increment = dec(inc);
        const r = roundToIncrement(x, increment, mode);
        expect(r.mod(increment).isZero()).toBe(true);
        const error = r.minus(x).abs();
        if (HALF_MODES.includes(mode)) {
          expect(error.lte(increment.div(2))).toBe(true);
        } else {
          expect(error.lt(increment)).toBe(true);
        }
      }),
    );
  });
});
