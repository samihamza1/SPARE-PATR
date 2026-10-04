import { z } from 'zod';

import { isCurrencyCode } from './currency.js';
import { isDecimalString } from './decimal.js';

/** JSON boundary: money and FX rates travel as decimal strings, never numbers. */
export const DecimalStringSchema = z
  .string()
  .refine(isDecimalString, { message: 'Expected a decimal string such as "12.50"' });

export const CurrencyCodeSchema = z
  .string()
  .refine(isCurrencyCode, { message: 'Expected an ISO 4217 code such as "ABC"' });

export const RoundingModeSchema = z.enum(['HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UP', 'DOWN']);

export const MoneySchema = z.object({
  amount: DecimalStringSchema,
  currency: CurrencyCodeSchema,
});

export const FxRateSchema = z.object({
  base: CurrencyCodeSchema,
  quote: CurrencyCodeSchema,
  rate: DecimalStringSchema,
});

export const MonetaryAmountSchema = z.object({
  amount: DecimalStringSchema,
  currency: CurrencyCodeSchema,
  fx: FxRateSchema,
  functionalAmount: DecimalStringSchema,
  functionalCurrency: CurrencyCodeSchema,
});
