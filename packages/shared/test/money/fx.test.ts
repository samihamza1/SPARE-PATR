import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CurrencySpec, FxQuote } from '../../src/money';
import {
  CurrencyMismatchError,
  convertByQuote,
  dec,
  fxQuoteSchema,
  money,
  toFunctionalByQuote,
} from '../../src/money';
import { HALF_MODES, positiveDecimalArb, roundingModeArb, scaledDecimalArb } from './arbitraries';

// Fictional currencies. A quote reads as the market says it: 1 BAS = rate QUO.
const BAS: CurrencySpec = { code: 'BAS', minorUnits: 2 };
const QUO: CurrencySpec = { code: 'QUO', minorUnits: 2 };
const ZER: CurrencySpec = { code: 'ZER', minorUnits: 0 };
const quote = (rate: string, base = 'BAS', q = 'QUO'): FxQuote => ({ base, quote: q, rate });

describe('convertByQuote: golden cases', () => {
  it('multiplies from the base and divides exactly from the quote currency', () => {
    const q = quote('3.6725');
    expect(convertByQuote(money('100.00', 'BAS'), q, QUO, 'HALF_UP')).toEqual({
      amount: '367.25',
      currency: 'QUO',
    });
    // 100 / 3.6725 = 27.2294...: divided exactly, rounded once.
    expect(convertByQuote(money('100.00', 'QUO'), q, BAS, 'HALF_UP')).toEqual({
      amount: '27.23',
      currency: 'BAS',
    });
    // 1 / 3 would round twice if the inverse rate were stored as 0.33.
    expect(convertByQuote(money('100', 'QUO'), quote('3'), BAS, 'HALF_UP').amount).toBe('33.33');
    expect(
      convertByQuote(money('1', 'BAS'), quote('1500.5', 'BAS', 'ZER'), ZER, 'HALF_EVEN'),
    ).toEqual({ amount: '1500', currency: 'ZER' });
  });

  it('refuses currencies that are not the two sides of the quote', () => {
    const q = quote('2');
    expect(() => convertByQuote(money('1', 'XXX'), q, BAS, 'HALF_UP')).toThrow(
      CurrencyMismatchError,
    );
    expect(() => convertByQuote(money('1', 'BAS'), q, BAS, 'HALF_UP')).toThrow(
      CurrencyMismatchError,
    );
    expect(() => convertByQuote(money('1', 'BAS'), quote('0'), QUO, 'HALF_UP')).toThrow(RangeError);
  });
});

describe('convertByQuote: properties', () => {
  it('converting back and forth stays within rounding of the start', () => {
    fc.assert(
      fc.property(
        scaledDecimalArb(2, { maxUnits: 10n ** 12n }),
        positiveDecimalArb(4).filter((r) => dec(r).gte('0.01') && dec(r).lte('100000')),
        fc.constantFrom(...HALF_MODES),
        (amount, rate, mode) => {
          const q = quote(rate);
          const there = convertByQuote(money(amount, 'QUO'), q, BAS, mode);
          const back = convertByQuote(there, q, QUO, mode);
          // Going QUO -> BAS loses at most half a BAS cent, i.e. rate/2 QUO cents, plus rounding back.
          const tolerance = dec(rate).times('0.005').plus('0.005');
          expect(dec(back.amount).minus(dec(amount)).abs().lte(tolerance)).toBe(true);
        },
      ),
    );
  });

  it('is monotonic in the amount for both directions', () => {
    fc.assert(
      fc.property(
        scaledDecimalArb(2),
        scaledDecimalArb(2),
        positiveDecimalArb(6),
        roundingModeArb,
        (a, b, rate, mode) => {
          const [lo, hi] = dec(a).lte(dec(b)) ? [a, b] : [b, a];
          const q = quote(rate);
          for (const [from, to] of [
            ['BAS', QUO],
            ['QUO', BAS],
          ] as const) {
            const x = convertByQuote(money(lo, from), q, to, mode);
            const y = convertByQuote(money(hi, from), q, to, mode);
            expect(dec(x.amount).lte(dec(y.amount))).toBe(true);
          }
        },
      ),
    );
  });
});

describe('toFunctionalByQuote', () => {
  it('records the rate as quoted, its direction and the rounded functional amount', () => {
    expect(toFunctionalByQuote(money('100.00', 'QUO'), quote('3.6725'), BAS, 'HALF_UP')).toEqual({
      amount: '100',
      currency: 'QUO',
      fxRate: '3.6725',
      fxBase: 'BAS',
      fxQuote: 'QUO',
      functionalAmount: '27.23',
    });
  });

  it('uses rate 1 for amounts already in the functional currency', () => {
    expect(toFunctionalByQuote(money('5.5', 'BAS'), null, BAS, 'HALF_UP')).toEqual({
      amount: '5.5',
      currency: 'BAS',
      fxRate: '1',
      fxBase: 'BAS',
      fxQuote: 'BAS',
      functionalAmount: '5.50',
    });
  });

  it('needs a quote that involves the functional currency', () => {
    expect(() => toFunctionalByQuote(money('1', 'QUO'), null, BAS, 'HALF_UP')).toThrow(
      CurrencyMismatchError,
    );
    expect(() =>
      toFunctionalByQuote(money('1', 'QUO'), quote('2', 'QUO', 'ZER'), BAS, 'HALF_UP'),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('fxQuoteSchema', () => {
  it('accepts a positive rate between two different currencies', () => {
    expect(fxQuoteSchema.safeParse(quote('3.6725')).success).toBe(true);
  });

  it.each([
    quote('0'),
    quote('-1'),
    quote('1e3'),
    quote('abc'),
    quote('1.12345678901'),
    quote('2', 'BAS', 'BAS'),
    quote('2', 'bas', 'QUO'),
  ])('rejects %o without throwing', (q) => {
    expect(fxQuoteSchema.safeParse(q).success).toBe(false);
  });
});
