import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DECIMAL_PATTERN,
  currencyCodeSchema,
  currencySpecSchema,
  dec,
  decimalStringSchema,
  fxRateSchema,
  monetaryAmountSchema,
  moneySchema,
} from '../../src/money';
import { decimalArb, positiveDecimalArb } from './arbitraries';

describe('zod schemas', () => {
  it('decimal strings are strings, never JS numbers', () => {
    expect(decimalStringSchema.safeParse('-12.50').success).toBe(true);
    expect(decimalStringSchema.safeParse(12.5).success).toBe(false);
    expect(decimalStringSchema.safeParse('1e3').success).toBe(false);
    expect(decimalStringSchema.safeParse('01').success).toBe(false);
  });

  it('currency codes are three upper-case letters (format only, no hardcoded list)', () => {
    expect(currencyCodeSchema.safeParse('ABC').success).toBe(true);
    expect(currencyCodeSchema.safeParse('abc').success).toBe(false);
    expect(currencyCodeSchema.safeParse('AB').success).toBe(false);
  });

  it('fx rates are strictly positive', () => {
    expect(fxRateSchema.safeParse('0.000123').success).toBe(true);
    expect(fxRateSchema.safeParse('0').success).toBe(false);
    expect(fxRateSchema.safeParse('-1').success).toBe(false);
  });

  it('money and monetary amounts', () => {
    expect(moneySchema.safeParse({ amount: '1.50', currency: 'ABC' }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: 1.5, currency: 'ABC' }).success).toBe(false);
    expect(
      monetaryAmountSchema.safeParse({
        amount: '10',
        currency: 'ABC',
        fxRate: '2.5',
        functionalAmount: '25.00',
      }).success,
    ).toBe(true);
    expect(
      monetaryAmountSchema.safeParse({ amount: '10', currency: 'ABC', fxRate: '2.5' }).success,
    ).toBe(false);
  });

  it('currency specs come from configuration and are validated', () => {
    expect(currencySpecSchema.safeParse({ code: 'ABC', minorUnits: 2 }).success).toBe(true);
    expect(
      currencySpecSchema.safeParse({ code: 'ABC', minorUnits: 0, cashIncrement: '250' }).success,
    ).toBe(true);
    expect(currencySpecSchema.safeParse({ code: 'ABC', minorUnits: -1 }).success).toBe(false);
    expect(currencySpecSchema.safeParse({ code: 'ABC', minorUnits: 1.5 }).success).toBe(false);
    expect(
      currencySpecSchema.safeParse({ code: 'ABC', minorUnits: 2, cashIncrement: '0' }).success,
    ).toBe(false);
  });
});

describe('zod schemas on malformed input', () => {
  // Strings that are not decimals, near-decimals decimal.js would parse, and real decimals.
  const anyString = fc.oneof(
    fc.string(),
    fc.string({ unit: fc.constantFrom(...'0123456789.-+eExX_ '.split('')) }),
    fc.constantFrom('', 'abc', '1e3', '01', '.5', '5.', '-', '0x10', 'NaN', 'Infinity', ' 1'),
    decimalArb(),
    positiveDecimalArb(),
  );
  const isPositiveDecimal = (s: string) => DECIMAL_PATTERN.test(s) && dec(s).gt(0);

  it('fxRateSchema fails validation, never throws (property)', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(fxRateSchema.safeParse(s).success).toBe(isPositiveDecimal(s));
      }),
    );
  });

  it('monetaryAmountSchema fails validation, never throws (property)', () => {
    fc.assert(
      fc.property(anyString, anyString, anyString, (amount, fxRate, functionalAmount) => {
        const result = monetaryAmountSchema.safeParse({
          amount,
          currency: 'ABC',
          fxRate,
          functionalAmount,
        });
        expect(result.success).toBe(
          DECIMAL_PATTERN.test(amount) &&
            isPositiveDecimal(fxRate) &&
            DECIMAL_PATTERN.test(functionalAmount),
        );
      }),
    );
  });

  it('currencySpecSchema fails validation, never throws (property)', () => {
    fc.assert(
      fc.property(anyString, fc.integer({ min: 0, max: 4 }), (cashIncrement, minorUnits) => {
        const result = currencySpecSchema.safeParse({ code: 'ABC', minorUnits, cashIncrement });
        expect(result.success).toBe(
          isPositiveDecimal(cashIncrement) && dec(cashIncrement).decimalPlaces() <= minorUnits,
        );
      }),
    );
  });

  it('reports the known throwing inputs as ordinary failures', () => {
    for (const s of ['abc', '', '1e3']) {
      expect(fxRateSchema.safeParse(s).success).toBe(false);
      expect(
        currencySpecSchema.safeParse({ code: 'ABC', minorUnits: 2, cashIncrement: s }).success,
      ).toBe(false);
    }
    const malformed = currencySpecSchema.safeParse({
      code: 'ABC',
      minorUnits: 2,
      cashIncrement: 'x',
    });
    expect(malformed.error?.issues.map((i) => i.path.join('.'))).toEqual(['cashIncrement']);
  });
});
