import { z } from 'zod';
import { DECIMAL_PATTERN, Decimal } from './decimal';
import { CURRENCY_CODE_PATTERN } from './money';
import { MAX_SCALE, ROUNDING_MODES } from './rounding';

/** Decimal values in JSON are strings such as "12.50", never JS numbers (invariant 1). */
export const decimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, 'Expected a decimal string such as "12.50"');

const positiveDecimalStringSchema = decimalStringSchema.refine((s) => new Decimal(s).gt(0), {
  message: 'Must be greater than zero',
});

/** Format check only: which currencies a tenant uses is configuration, not code. */
export const currencyCodeSchema = z.string().regex(CURRENCY_CODE_PATTERN, 'Expected ISO 4217 code');

/** Units of the target currency per 1 unit of the source currency. */
export const fxRateSchema = positiveDecimalStringSchema;

export const roundingModeSchema = z.enum(ROUNDING_MODES);

export const moneySchema = z.object({
  amount: decimalStringSchema,
  currency: currencyCodeSchema,
});

export const monetaryAmountSchema = z.object({
  amount: decimalStringSchema,
  currency: currencyCodeSchema,
  fxRate: fxRateSchema,
  functionalAmount: decimalStringSchema,
});

export const currencySpecSchema = z
  .object({
    code: currencyCodeSchema,
    minorUnits: z.number().int().min(0).max(MAX_SCALE),
    cashIncrement: positiveDecimalStringSchema.optional(),
  })
  .refine(
    (spec) =>
      spec.cashIncrement === undefined ||
      new Decimal(spec.cashIncrement).decimalPlaces() <= spec.minorUnits,
    { message: 'cashIncrement cannot be finer than the minor unit', path: ['cashIncrement'] },
  );
