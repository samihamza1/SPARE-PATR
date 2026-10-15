import { describe, expect, it } from 'vitest';
import {
  currencyCodeSchema,
  currencySpecSchema,
  decimalStringSchema,
  fxRateSchema,
  monetaryAmountSchema,
  moneySchema,
} from '../../src/money';

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
