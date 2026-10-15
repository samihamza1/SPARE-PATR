import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CurrencySpec } from '../../src/money';
import {
  CurrencyMismatchError,
  convert,
  dec,
  money,
  roundMoney,
  toFunctional,
} from '../../src/money';
import { decimalArb, positiveDecimalArb, roundingModeArb } from './arbitraries';

// Fictional currencies; the rate convention is "units of the target currency per 1 unit of the source".
const AAA: CurrencySpec = { code: 'AAA', minorUnits: 2 };
const BBB: CurrencySpec = { code: 'BBB', minorUnits: 2 };
const TRI: CurrencySpec = { code: 'TRI', minorUnits: 3 };
const ZER: CurrencySpec = { code: 'ZER', minorUnits: 0 };

describe('convert: golden cases', () => {
  it.each([
    ['100.00', '3.6725', BBB, 'HALF_UP', '367.25'],
    ['10', '0.333', TRI, 'HALF_UP', '3.330'],
    ['1.00', '1500.5', ZER, 'HALF_EVEN', '1500'],
    ['1.00', '1500.5', ZER, 'HALF_UP', '1501'],
    ['-1.00', '1500.5', ZER, 'HALF_UP', '-1501'],
    ['0.01', '0.0001', BBB, 'HALF_UP', '0.00'],
  ] as const)('%s AAA @ %s -> %o (%s) = %s', (amount, rate, to, mode, expected) => {
    expect(convert(money(amount, 'AAA'), rate, to, mode)).toEqual({
      amount: expected,
      currency: to.code,
    });
  });

  it('rejects non-positive or malformed rates', () => {
    const m = money('1', 'AAA');
    expect(() => convert(m, '0', BBB, 'HALF_UP')).toThrow(RangeError);
    expect(() => convert(m, '-1.2', BBB, 'HALF_UP')).toThrow(RangeError);
    expect(() => convert(m, '1e2', BBB, 'HALF_UP')).toThrow(TypeError);
    expect(() => convert(m, 1.2 as unknown as string, BBB, 'HALF_UP')).toThrow(TypeError);
  });

  it('refuses a same-currency conversion at a rate other than 1', () => {
    expect(() => convert(money('1', 'AAA'), '1.1', AAA, 'HALF_UP')).toThrow(CurrencyMismatchError);
  });
});

describe('convert: properties', () => {
  it('rate 1 into the same currency only rounds', () => {
    fc.assert(
      fc.property(decimalArb(), roundingModeArb, (x, mode) => {
        const m = money(x, 'AAA');
        expect(convert(m, '1', AAA, mode)).toEqual(roundMoney(m, AAA, mode));
      }),
    );
  });

  it('is monotonic for a positive rate', () => {
    fc.assert(
      fc.property(
        decimalArb(),
        decimalArb(),
        positiveDecimalArb(),
        roundingModeArb,
        (x, y, rate, mode) => {
          const [lo, hi] = dec(x).lte(dec(y)) ? [x, y] : [y, x];
          const a = convert(money(lo, 'AAA'), rate, BBB, mode);
          const b = convert(money(hi, 'AAA'), rate, BBB, mode);
          expect(dec(a.amount).lte(dec(b.amount))).toBe(true);
        },
      ),
    );
  });

  it('errs by at most half a target minor unit in half modes', () => {
    fc.assert(
      fc.property(decimalArb(), positiveDecimalArb(), (x, rate) => {
        const out = convert(money(x, 'AAA'), rate, TRI, 'HALF_EVEN');
        const exact = dec(x).times(dec(rate));
        expect(dec(out.amount).minus(exact).abs().lte(dec('0.0005'))).toBe(true);
      }),
    );
  });
});

describe('toFunctional', () => {
  it('records amount, currency, rate used and functional amount (invariant 2)', () => {
    expect(toFunctional(money('100.00', 'AAA'), '3.67250', BBB, 'HALF_UP')).toEqual({
      amount: '100',
      currency: 'AAA',
      fxRate: '3.6725',
      functionalAmount: '367.25',
    });
  });

  it('uses rate 1 for amounts already in the functional currency', () => {
    expect(toFunctional(money('10.5', 'BBB'), '1', BBB, 'HALF_UP')).toEqual({
      amount: '10.5',
      currency: 'BBB',
      fxRate: '1',
      functionalAmount: '10.50',
    });
    expect(() => toFunctional(money('10.5', 'BBB'), '2', BBB, 'HALF_UP')).toThrow(
      CurrencyMismatchError,
    );
  });

  it('is consistent with convert (property)', () => {
    fc.assert(
      fc.property(decimalArb(), positiveDecimalArb(), roundingModeArb, (x, rate, mode) => {
        const m = money(x, 'AAA');
        const f = toFunctional(m, rate, BBB, mode);
        expect(f.functionalAmount).toBe(convert(m, rate, BBB, mode).amount);
        expect(dec(f.fxRate).eq(dec(rate))).toBe(true);
        expect(f.amount).toBe(m.amount);
        expect(f.currency).toBe('AAA');
      }),
    );
  });
});
