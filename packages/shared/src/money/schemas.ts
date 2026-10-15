import { z } from 'zod';
import { DECIMAL_PATTERN, Decimal } from './decimal';
import { CURRENCY_CODE_PATTERN } from './money';
import { MAX_SCALE, ROUNDING_MODES } from './rounding';

const DECIMAL_MESSAGE = 'Expected a decimal string such as "12.50"';

/** Decimal values in JSON are strings such as "12.50", never JS numbers (invariant 1). */
export const decimalStringSchema = z.string().regex(DECIMAL_PATTERN, DECIMAL_MESSAGE);

/**
 * Zod 4 runs later checks even after a failed regex, and decimal.js throws on malformed
 * input. `abort` stops at the regex, so a malformed value is an ordinary validation
 * failure, never an exception (which the API would answer with a 500).
 */
const positiveDecimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, { message: DECIMAL_MESSAGE, abort: true })
  .refine((s) => new Decimal(s).gt(0), { message: 'Must be greater than zero' });

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
      // A malformed value already failed its own field check; never parse it here.
      !DECIMAL_PATTERN.test(spec.cashIncrement) ||
      new Decimal(spec.cashIncrement).decimalPlaces() <= spec.minorUnits,
    { message: 'cashIncrement cannot be finer than the minor unit', path: ['cashIncrement'] },
  );
