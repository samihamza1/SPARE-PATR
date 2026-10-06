import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal, dec, divideRounded, round, shift, toDecimalString } from '../../src/money';
import { HALF_MODES, decimalArb, positiveDecimalArb, roundingModeArb } from './arbitraries';

const nonZeroArb = decimalArb({ maxScale: 6, maxUnits: 10n ** 9n }).filter((d) => !dec(d).isZero());

describe('divideRounded: golden cases', () => {
  it.each([
    ['100', '3', 2, 'HALF_UP', '33.33'],
    ['200', '3', 2, 'HALF_UP', '66.67'],
    ['-200', '3', 2, 'HALF_UP', '-66.67'],
    ['100.00', '3.6725', 2, 'HALF_UP', '27.23'],
    ['1', '8', 2, 'HALF_EVEN', '0.12'],
    ['1', '8', 2, 'HALF_UP', '0.13'],
    ['3', '8', 2, 'HALF_EVEN', '0.38'],
    ['10', '-4', 0, 'HALF_UP', '-3'],
    ['10', '-4', 0, 'HALF_EVEN', '-2'],
    ['1', '3', 0, 'CEIL', '1'],
    ['-1', '3', 0, 'FLOOR', '-1'],
    ['0', '7', 2, 'UP', '0'],
  ] as const)('%s / %s at %i places (%s) = %s', (n, d, scale, mode, expected) => {
    expect(toDecimalString(divideRounded(n, d, scale, mode))).toBe(toDecimalString(dec(expected)));
  });

  it('rejects a zero denominator and invalid scales', () => {
    expect(() => divideRounded('1', '0', 2, 'HALF_UP')).toThrow(RangeError);
    expect(() => divideRounded('1', '2', -1, 'HALF_UP')).toThrow(RangeError);
  });
});

describe('divideRounded: properties', () => {
  it('equals rounding the exact quotient when the quotient terminates', () => {
    // n * d / d terminates, so decimal.js gives the exact quotient to compare with.
    fc.assert(
      fc.property(
        decimalArb({ maxScale: 4 }),
        nonZeroArb,
        fc.integer({ min: 0, max: 6 }),
        roundingModeArb,
        (x, d, scale, mode) => {
          const n = dec(x).times(dec(d));
          expect(divideRounded(n, d, scale, mode).eq(round(dec(x), scale, mode))).toBe(true);
        },
      ),
    );
  });

  it('lies within half a unit of the exact quotient for the half modes', () => {
    fc.assert(
      fc.property(
        decimalArb(),
        nonZeroArb,
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom(...HALF_MODES),
        (n, d, scale, mode) => {
          const q = divideRounded(n, d, scale, mode);
          // |n - q*d| <= ulp * |d| / 2, checked without dividing.
          const ulp = shift(new Decimal(1), -scale);
          const error = dec(n)
            .minus(q.times(dec(d)))
            .abs();
          expect(error.lte(ulp.times(dec(d).abs()).div(2))).toBe(true);
        },
      ),
    );
  });

  it('is never off by a full unit in any mode', () => {
    fc.assert(
      fc.property(
        decimalArb(),
        nonZeroArb,
        fc.integer({ min: 0, max: 6 }),
        roundingModeArb,
        (n, d, scale, mode) => {
          const q = divideRounded(n, d, scale, mode);
          const ulp = shift(new Decimal(1), -scale);
          const error = dec(n)
            .minus(q.times(dec(d)))
            .abs();
          expect(error.lt(ulp.times(dec(d).abs()))).toBe(true);
          expect(q.decimalPlaces()).toBeLessThanOrEqual(scale);
        },
      ),
    );
  });

  it('splitting a value V over Q units as round(V*q/Q) never drifts', () => {
    // Issuing a stock value V of Q units in parts: the last part takes the remainder, so the
    // parts always add back to V exactly. This mirrors how AVCO issues stock.
    fc.assert(
      fc.property(
        positiveDecimalArb(2),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 10 }),
        roundingModeArb,
        (value, parts, mode) => {
          const v = round(value, 2, 'DOWN');
          let remainingQty = parts.reduce((a, b) => a + b, 0);
          let remainingValue = v;
          let issued = new Decimal(0);
          for (const part of parts) {
            const cost =
              part === remainingQty
                ? remainingValue
                : divideRounded(remainingValue.times(String(part)), String(remainingQty), 2, mode);
            issued = issued.plus(cost);
            remainingValue = remainingValue.minus(cost);
            remainingQty -= part;
          }
          expect(issued.eq(v)).toBe(true);
          expect(remainingValue.isZero()).toBe(true);
        },
      ),
    );
  });
});
