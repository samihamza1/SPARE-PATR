import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CurrencySpec } from '../../src/money';
import {
  CurrencyMismatchError,
  add,
  compare,
  dec,
  isZero,
  money,
  mul,
  neg,
  roundCash,
  roundMoney,
  sub,
  sum,
} from '../../src/money';
import { decimalArb } from './arbitraries';

// Fictional currencies: real codes, minor units and cash increments come from tenant configuration.
const AAA: CurrencySpec = { code: 'AAA', minorUnits: 2 };
const CASH: CurrencySpec = { code: 'CSH', minorUnits: 2, cashIncrement: '0.05' };
const BIG: CurrencySpec = { code: 'BIG', minorUnits: 0, cashIncrement: '250' };

const aaa = (amount: string) => money(amount, 'AAA');
const eqMoney = (a: { amount: string }, b: { amount: string }) => dec(a.amount).eq(dec(b.amount));

describe('money()', () => {
  it('normalises the amount and keeps the currency', () => {
    expect(money('10.50', 'AAA')).toEqual({ amount: '10.5', currency: 'AAA' });
    expect(money('-0', 'AAA')).toEqual({ amount: '0', currency: 'AAA' });
  });

  it('rejects malformed currency codes and amounts', () => {
    expect(() => money('1', 'aaa')).toThrow(TypeError);
    expect(() => money('1', 'AAAA')).toThrow(TypeError);
    expect(() => money('1.', 'AAA')).toThrow(TypeError);
    expect(() => money(1 as unknown as string, 'AAA')).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('refuses to mix currencies', () => {
    const b = money('1', 'BBB');
    expect(() => add(aaa('1'), b)).toThrow(CurrencyMismatchError);
    expect(() => sub(aaa('1'), b)).toThrow(CurrencyMismatchError);
    expect(() => compare(aaa('1'), b)).toThrow(CurrencyMismatchError);
    expect(() => sum('AAA', [aaa('1'), b])).toThrow(CurrencyMismatchError);
  });

  it('is exact where floats are not', () => {
    expect(add(aaa('0.1'), aaa('0.2'))).toEqual(aaa('0.3'));
    expect(mul(aaa('1.1'), '3')).toEqual(aaa('3.3'));
  });

  it('sum of nothing is zero in the requested currency', () => {
    expect(sum('AAA', [])).toEqual(aaa('0'));
  });

  it('addition is commutative and associative, exactly (property)', () => {
    fc.assert(
      fc.property(decimalArb(), decimalArb(), decimalArb(), (x, y, z) => {
        const [a, b, c] = [aaa(x), aaa(y), aaa(z)];
        expect(add(a, b)).toEqual(add(b, a));
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
      }),
    );
  });

  it('subtraction inverts addition, exactly (property)', () => {
    fc.assert(
      fc.property(decimalArb(), decimalArb(), (x, y) => {
        expect(add(sub(aaa(x), aaa(y)), aaa(y))).toEqual(aaa(x));
        expect(add(aaa(x), neg(aaa(x)))).toEqual(aaa('0'));
      }),
    );
  });

  it('compare and isZero agree with decimal ordering (property)', () => {
    fc.assert(
      fc.property(decimalArb(), decimalArb(), (x, y) => {
        expect(compare(aaa(x), aaa(y))).toBe(dec(x).comparedTo(dec(y)));
        expect(isZero(sub(aaa(x), aaa(x)))).toBe(true);
      }),
    );
  });
});

describe('roundMoney', () => {
  it('rounds to the configured minor units and pads the string', () => {
    expect(roundMoney(aaa('10.005'), AAA, 'HALF_UP')).toEqual({ amount: '10.01', currency: 'AAA' });
    expect(roundMoney(aaa('10.005'), AAA, 'HALF_EVEN')).toEqual({
      amount: '10.00',
      currency: 'AAA',
    });
    expect(roundMoney(aaa('7'), AAA, 'HALF_UP')).toEqual({ amount: '7.00', currency: 'AAA' });
  });

  it('refuses a spec for another currency', () => {
    expect(() => roundMoney(aaa('1'), CASH, 'HALF_UP')).toThrow(CurrencyMismatchError);
  });

  it('always yields exactly minorUnits decimal places (property)', () => {
    fc.assert(
      fc.property(decimalArb(), fc.integer({ min: 0, max: 4 }), (x, minorUnits) => {
        const out = roundMoney(aaa(x), { code: 'AAA', minorUnits }, 'HALF_EVEN');
        const decimals = out.amount.split('.')[1] ?? '';
        expect(decimals.length).toBe(minorUnits);
      }),
    );
  });
});

describe('roundCash', () => {
  it('uses the configured cash increment', () => {
    expect(roundCash(money('1.12', 'CSH'), CASH, 'HALF_UP').amount).toBe('1.10');
    expect(roundCash(money('1.13', 'CSH'), CASH, 'HALF_UP').amount).toBe('1.15');
    expect(roundCash(money('1125', 'BIG'), BIG, 'HALF_UP').amount).toBe('1250');
  });

  it('falls back to the minor unit when no cash increment is configured', () => {
    expect(roundCash(aaa('1.126'), AAA, 'HALF_UP').amount).toBe('1.13');
  });

  it('cash-rounded values are multiples of the increment (property)', () => {
    fc.assert(
      fc.property(decimalArb(), (x) => {
        const out = roundCash(money(x, 'CSH'), CASH, 'HALF_EVEN');
        expect(dec(out.amount).mod(dec('0.05')).isZero()).toBe(true);
        expect(eqMoney(out, roundMoney(out, CASH, 'HALF_EVEN'))).toBe(true);
      }),
    );
  });
});
