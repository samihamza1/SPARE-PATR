import { z } from 'zod';
import { uuidSchema, uuidV7Schema } from '../ids';
import { currencyCodeSchema, decimalStringSchema } from '../money';
import { quotedRateSchema } from '../money/fx';

const timestampSchema = z.iso.datetime({ offset: true });
const dateSchema = z.iso.date();
const nameSchema = z.string().trim().min(1).max(100);
const noteSchema = z.string().trim().max(500);

// --- locations (ADR 0018) ---------------------------------------------------------------

/** Shops sell; warehouses (storerooms, depots) only hold stock. */
export const LOCATION_KINDS = ['shop', 'warehouse'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const locationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  kind: z.enum(LOCATION_KINDS),
  isDefault: z.boolean(),
  sortOrder: z.int(),
  archivedAt: timestampSchema.nullable(),
});
export type Location = z.infer<typeof locationSchema>;

export const createLocationSchema = z.object({
  id: uuidV7Schema,
  name: nameSchema,
  kind: z.enum(LOCATION_KINDS),
  sortOrder: z.int().min(0).max(10000).optional(),
});

export const updateLocationSchema = z
  .object({
    name: nameSchema,
    sortOrder: z.int().min(0).max(10000),
    /** Makes this shop the default; the previous default stops being one. */
    isDefault: z.literal(true),
    archived: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'request.empty' });

export const listLocationsQuerySchema = z.object({
  includeArchived: z.stringbool().optional(),
});

export const setDeviceLocationSchema = z.object({ locationId: uuidSchema });

// --- exchange rates (ADR 0019) ----------------------------------------------------------

/** A recorded rate, as quoted: 1 base = rate quote. */
export const fxRateRecordSchema = z.object({
  id: uuidSchema,
  base: currencyCodeSchema,
  quote: currencyCodeSchema,
  rate: decimalStringSchema,
  rateDate: dateSchema,
  note: z.string().nullable(),
  recordedAt: timestampSchema,
  recordedBy: uuidSchema,
});
export type FxRateRecord = z.infer<typeof fxRateRecordSchema>;

export const createFxRateSchema = z
  .object({
    id: uuidV7Schema,
    base: currencyCodeSchema,
    quote: currencyCodeSchema,
    rate: quotedRateSchema,
    /** Business date in the tenant's time zone; defaults to today. Never in the future. */
    rateDate: dateSchema.optional(),
    note: noteSchema.nullish(),
  })
  .refine((b) => b.base !== b.quote, { message: 'fx.same_currency', path: ['quote'] });

export const listFxRatesQuerySchema = z.object({
  /** The non-functional side of the pair. */
  currency: currencyCodeSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** The rate in effect today for each active currency other than the functional one. */
export const currentFxRatesSchema = z.object({
  businessDate: dateSchema,
  functionalCurrency: currencyCodeSchema,
  rates: z.array(
    z.object({
      currency: currencyCodeSchema,
      rate: fxRateRecordSchema.nullable(),
      /** False when no rate was entered for today (the latest one is older, or none). */
      enteredToday: z.boolean(),
    }),
  ),
});
export type CurrentFxRates = z.infer<typeof currentFxRatesSchema>;

// --- stock (ADR 0020, 0021) -------------------------------------------------------------

export const MOVE_KINDS = [
  'opening',
  'adjustment',
  'count',
  'transfer_out',
  'transfer_in',
  'part_transfer_out',
  'part_transfer_in',
  'cost_adjustment',
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** Why stock was adjusted; the reason decides the direction (data correction: either). */
export const ADJUSTMENT_REASONS = ['damaged', 'lost', 'found', 'data_correction'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const STOCK_DOCUMENT_KINDS = [
  'opening',
  'adjustment',
  'transfer',
  'part_transfer',
  'count',
] as const;
export type StockDocumentKind = (typeof STOCK_DOCUMENT_KINDS)[number];

/** Value of stock; only sent to users with cost.view (BRIEF: cashiers never see cost). */
export const stockValueSchema = z.object({
  currency: currencyCodeSchema,
  value: decimalStringSchema,
  /** value / quantity at the currency's minor units; null when nothing is on hand. */
  averageCost: decimalStringSchema.nullable(),
});
export type StockValue = z.infer<typeof stockValueSchema>;

export const partStockSchema = z.object({
  partId: uuidSchema,
  /** Across all locations; may be negative after accepted offline sales. */
  total: z.int(),
  locations: z.array(
    z.object({
      locationId: uuidSchema,
      quantity: z.int(),
      lastInAt: timestampSchema.nullable(),
      lastOutAt: timestampSchema.nullable(),
    }),
  ),
  cost: stockValueSchema.optional(),
});
export type PartStock = z.infer<typeof partStockSchema>;

export const stockMoveSchema = z.object({
  id: uuidSchema,
  /** Server order (a bigint as a string). */
  seq: z.string(),
  documentId: uuidSchema,
  documentKind: z.enum(STOCK_DOCUMENT_KINDS),
  lineNo: z.int(),
  partId: uuidSchema,
  locationId: uuidSchema.nullable(),
  kind: z.enum(MOVE_KINDS),
  reason: z.enum(ADJUSTMENT_REASONS).nullable(),
  quantity: z.int(),
  occurredAt: timestampSchema,
  recordedAt: timestampSchema,
  /** Invariant 2, only with cost.view. */
  cost: z
    .object({
      amount: decimalStringSchema,
      currency: currencyCodeSchema,
      fxRate: decimalStringSchema,
      fxBase: currencyCodeSchema,
      fxQuote: currencyCodeSchema,
      functionalAmount: decimalStringSchema,
    })
    .optional(),
});
export type StockMove = z.infer<typeof stockMoveSchema>;

export const listStockMovesQuerySchema = z.object({
  partId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  documentId: uuidSchema.optional(),
  /** Keyset pagination: moves before this seq, newest first. */
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listStockBalancesQuerySchema = z.object({
  locationId: uuidSchema.optional(),
  /** Hide parts with zero quantity at every listed location. */
  nonZero: z.stringbool().optional(),
  /** Keyset pagination on SKU. */
  after: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const stockBalanceRowSchema = z.object({
  partId: uuidSchema,
  sku: z.string(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  locationId: uuidSchema,
  quantity: z.int(),
  lastInAt: timestampSchema.nullable(),
  lastOutAt: timestampSchema.nullable(),
});
export type StockBalanceRow = z.infer<typeof stockBalanceRowSchema>;
