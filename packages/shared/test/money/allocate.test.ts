import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CurrencySpec } from '../../src/money';
import { CurrencyMismatchError, allocate, dec, money, shift } from '../../src/money';
import { minorUnitsArb, scaledDecimalArb, unitsToDecimalString } from './arbitraries';

const AAA: CurrencySpec = { code: 'AAA', minorUnits: 2 };
const amounts = (parts: { amount: string }[]) => parts.map((p) => p.amount);

const weightArb = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 6n }), fc.integer({ min: 0, max: 3 }))
  .map(([units, scale]) => unitsToDecimalString(units, scale));
const weightsArb = fc
  .array(weightArb, { minLength: 1, maxLength: 12 })
  .filter((ws) => ws.some((w) => !dec(w).isZero()));

describe('allocate: golden cases', () => {
  it('gives the leftover cent to the earliest largest remainder', () => {
    expect(amounts(allocate(money('100.00', 'AAA'), ['1', '1', '1'], AAA))).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
  });

  it('handles totals smaller than the number of parts', () => {
    expect(amounts(allocate(money('0.05', 'AAA'), ['1', '1', '1', '1', '1', '1'], AAA))).toEqual([
      '0.01',
      '0.01',
      '0.01',
      '0.01',
      '0.01',
      '0.00',
    ]);
  });

  it('mirrors positive allocation for negative totals', () => {
    expect(amounts(allocate(money('-100.00', 'AAA'), ['1', '1', '1'], AAA))).toEqual([
      '-33.34',
      '-33.33',
      '-33.33',
    ]);
  });

  it('accepts decimal weights and gives zero weights nothing', () => {
    expect(amounts(allocate(money('10', 'AAA'), ['0.5', '0', '1.5'], AAA))).toEqual([
      '2.50',
      '0.00',
      '7.50',
    ]);
  });

  it('rejects invalid input', () => {
    const total = money('10.00', 'AAA');
    expect(() => allocate(total, [], AAA)).toThrow(RangeError);
    expect(() => allocate(total, ['0', '0'], AAA)).toThrow(RangeError);
    expect(() => allocate(total, ['1', '-1'], AAA)).toThrow(RangeError);
    expect(() => allocate(money('10.001', 'AAA'), ['1'], AAA)).toThrow(RangeError);
    expect(() => allocate(money('10', 'BBB'), ['1'], AAA)).toThrow(CurrencyMismatchError);
  });
});

describe('allocate: properties', () => {
  const caseArb = minorUnitsArb.chain((minorUnits) =>
    fc.record({
      minorUnits: fc.constant(minorUnits),
      total: scaledDecimalArb(minorUnits),
      weights: weightsArb,
    }),
  );

  it('parts always sum exactly to the total', () => {
    fc.assert(
      fc.property(caseArb, ({ minorUnits, total, weights }) => {
        const parts = allocate(money(total, 'AAA'), weights, { code: 'AAA', minorUnits });
        expect(parts).toHaveLength(weights.length);
        const partsSum = parts.reduce((acc, p) => acc.plus(dec(p.amount)), dec('0'));
        expect(partsSum.eq(dec(total))).toBe(true);
      }),
    );
  });

  it('each part is within one minor unit of its exact proportional share', () => {
    fc.assert(
      fc.property(caseArb, ({ minorUnits, total, weights }) => {
        const parts = allocate(money(total, 'AAA'), weights, { code: 'AAA', minorUnits });
        const weightSum = weights.reduce((acc, w) => acc.plus(dec(w)), dec('0'));
        const unit = shift(dec('1'), -minorUnits);
        parts.forEach((part, i) => {
          const exact = dec(total)
            .times(dec(weights[i] ?? '0'))
            .div(weightSum);
          expect(dec(part.amount).minus(exact).abs().lt(unit)).toBe(true);
          expect(part.amount.split('.')[1]?.length ?? 0).toBe(minorUnits);
          if (dec(weights[i] ?? '0').isZero()) expect(dec(part.amount).isZero()).toBe(true);
        });
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(caseArb, ({ minorUnits, total, weights }) => {
        const spec = { code: 'AAA', minorUnits };
        expect(allocate(money(total, 'AAA'), weights, spec)).toEqual(
          allocate(money(total, 'AAA'), weights, spec),
        );
      }),
    );
  });
});
