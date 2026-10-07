import { z } from 'zod';
import { uuidSchema, uuidV7Schema } from '../ids';
import { DECIMAL_PATTERN, currencyCodeSchema, dec, decimalStringSchema } from '../money';
import { requireChange } from '../patch';
import { MAX_QUANTITY, quantitySchema } from './quantity';
import { ADJUSTMENT_REASONS, STOCK_DOCUMENT_KINDS, stockMoveSchema } from './schemas';

const timestampSchema = z.iso.datetime({ offset: true });
const dateSchema = z.iso.date();
const noteSchema = z.string().trim().min(1).max(500);
const MAX_LINES = 500;

/** A non-negative decimal amount, e.g. a unit cost "13.16". */
const nonNegativeDecimalSchema = decimalStringSchema.refine(
  (s) => DECIMAL_PATTERN.test(s) && dec(s).gte(0),
  { message: 'Must not be negative' },
);

/** A unit cost as entered, in any tenant currency; converted at the rate in effect. */
export const unitCostSchema = z.object({
  amount: nonNegativeDecimalSchema,
  currency: currencyCodeSchema,
});
export type UnitCost = z.infer<typeof unitCostSchema>;

const distinctParts = (lines: readonly { partId: string }[]) =>
  new Set(lines.map((l) => l.partId)).size === lines.length;

// --- posted documents (ADR 0020) ----------------------------------------------------------

export const stockDocumentSchema = z.object({
  id: uuidSchema,
  kind: z.enum(STOCK_DOCUMENT_KINDS),
  note: z.string().nullable(),
  origin: z.enum(['online', 'offline']),
  occurredAt: timestampSchema,
  postedAt: timestampSchema,
  postedBy: uuidSchema,
  moves: z.array(stockMoveSchema),
});
export type StockDocument = z.infer<typeof stockDocumentSchema>;

/**
 * Stock adjustment (stock.adjust). The reason decides the direction: lost and damaged take
 * stock out, found adds it, a data correction goes either way. Units added take the entered
 * unit cost, or the part's average when none is given.
 */
export const adjustmentRequestSchema = z
  .object({
    id: uuidV7Schema,
    locationId: uuidSchema,
    reason: z.enum(ADJUSTMENT_REASONS),
    note: noteSchema.nullish(),
    lines: z
      .array(
        z.object({
          partId: uuidSchema,
          /** Signed whole units: negative takes stock out. */
          quantity: z
            .int()
            .min(-MAX_QUANTITY)
            .max(MAX_QUANTITY)
            .refine((q) => q !== 0, { message: 'stock.zero_quantity' }),
          unitCost: unitCostSchema.nullish(),
        }),
      )
      .min(1)
      .max(MAX_LINES)
      .refine(distinctParts, { message: 'stock.duplicate_part' }),
  })
  .superRefine((b, ctx) => {
    b.lines.forEach((line, i) => {
      const wrongSign =
        ((b.reason === 'lost' || b.reason === 'damaged') && line.quantity > 0) ||
        (b.reason === 'found' && line.quantity < 0);
      if (wrongSign) {
        ctx.addIssue({
          code: 'custom',
          message: 'stock.reason_direction',
          path: ['lines', i, 'quantity'],
        });
      }
      if (line.quantity < 0 && line.unitCost != null) {
        ctx.addIssue({
          code: 'custom',
          message: 'stock.cost_on_issue',
          path: ['lines', i, 'unitCost'],
        });
      }
    });
  });
export type AdjustmentRequest = z.infer<typeof adjustmentRequestSchema>;

/** Transfer between locations (stock.transfer), at the average cost. */
export const transferRequestSchema = z
  .object({
    id: uuidV7Schema,
    fromLocationId: uuidSchema,
    toLocationId: uuidSchema,
    note: noteSchema.nullish(),
    lines: z
      .array(z.object({ partId: uuidSchema, quantity: quantitySchema }))
      .min(1)
      .max(MAX_LINES)
      .refine(distinctParts, { message: 'stock.duplicate_part' }),
  })
  .refine((b) => b.fromLocationId !== b.toLocationId, {
    message: 'stock.same_location',
    path: ['toLocationId'],
  });
export type TransferRequest = z.infer<typeof transferRequestSchema>;

/**
 * Moves every positive balance of a superseded part to its replacement, on request only
 * (product owner, 2026-10-06).
 */
export const partTransferRequestSchema = z.object({
  id: uuidV7Schema,
  partId: uuidSchema,
  note: noteSchema.nullish(),
});

// --- opening stock (ADR 0024) -------------------------------------------------------------

export const OPENING_LINE_STATUSES = ['ready', 'needs_cost', 'needs_quantity', 'excluded'] as const;
export type OpeningLineStatus = (typeof OPENING_LINE_STATUSES)[number];
export const OPENING_EXCLUSIONS = ['by_user', 'already_opened', 'no_quantity'] as const;

export const createOpeningSchema = z.object({
  id: uuidV7Schema,
  batchId: uuidSchema,
  /** Defaults to the default shop. */
  locationId: uuidSchema.optional(),
  /** The go-live date (tenant time zone); defaults to today. */
  asOf: dateSchema.optional(),
});

export const updateOpeningSchema = requireChange(
  z
    .object({
      locationId: uuidSchema,
      asOf: dateSchema,
      /** The go-live day's rate, when costs are in another currency. */
      fxRateId: uuidSchema.nullable(),
    })
    .partial(),
);

export const updateOpeningLineSchema = requireChange(
  z
    .object({
      quantity: quantitySchema,
      /** Unit cost in the draft's cost currency; null clears an entered cost. */
      unitCost: nonNegativeDecimalSchema.nullable(),
      excluded: z.boolean(),
    })
    .partial(),
);

export const openingLineSchema = z.object({
  partId: uuidSchema,
  sku: z.string(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  /** Rows of the file combined into this line (repeated part numbers). */
  rows: z.int(),
  /** Sum of the file's quantities as read. */
  fileQuantity: z.string().nullable(),
  quantity: z.int().nullable(),
  /** Total cost in the draft's cost currency; null while it needs a cost. */
  amount: decimalStringSchema.nullable(),
  unitCost: decimalStringSchema.nullable(),
  costSource: z.enum(['file', 'entered']).nullable(),
  /** Average unit cost of this part's rows that had one, offered when some did not. */
  suggestedUnitCost: decimalStringSchema.nullable(),
  status: z.enum(OPENING_LINE_STATUSES),
  exclusion: z.enum(OPENING_EXCLUSIONS).nullable(),
});
export type OpeningLine = z.infer<typeof openingLineSchema>;

export const openingDraftSchema = z.object({
  id: uuidSchema,
  batchId: uuidSchema,
  fileName: z.string(),
  locationId: uuidSchema,
  asOf: dateSchema,
  costCurrency: currencyCodeSchema,
  functionalCurrency: currencyCodeSchema,
  fxRate: z
    .object({
      id: uuidSchema,
      base: currencyCodeSchema,
      quote: currencyCodeSchema,
      rate: z.string(),
    })
    .nullable(),
  status: z.enum(['draft', 'posted', 'discarded']),
  counts: z.record(z.enum(OPENING_LINE_STATUSES), z.int()),
  /** Totals of the ready lines: units, cost currency, and functional currency (null without a rate). */
  totals: z.object({
    quantity: z.int(),
    amount: decimalStringSchema,
    functionalAmount: decimalStringSchema.nullable(),
  }),
  postedAt: timestampSchema.nullable(),
});
export type OpeningDraft = z.infer<typeof openingDraftSchema>;

export const openingSummarySchema = z.object({
  id: uuidSchema,
  batchId: uuidSchema,
  fileName: z.string(),
  status: z.enum(['draft', 'posted', 'discarded']),
  createdAt: timestampSchema,
  postedAt: timestampSchema.nullable(),
});
export type OpeningSummary = z.infer<typeof openingSummarySchema>;

export const listOpeningLinesQuerySchema = z.object({
  status: z.enum(OPENING_LINE_STATUSES).optional(),
  /** Keyset pagination on SKU. */
  after: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// --- counts (ADR 0025) --------------------------------------------------------------------

export const COUNT_SCOPES = ['all', 'category', 'parts'] as const;
export const COUNT_STATUSES = ['open', 'approved', 'cancelled'] as const;

export const createCountSchema = z
  .object({
    id: uuidV7Schema,
    locationId: uuidSchema,
    scope: z.enum(COUNT_SCOPES),
    categoryId: uuidSchema.optional(),
    partIds: z.array(uuidSchema).min(1).max(5000).optional(),
    note: noteSchema.nullish(),
  })
  .refine((b) => (b.scope === 'category') === (b.categoryId !== undefined), {
    message: 'count.scope',
    path: ['categoryId'],
  })
  .refine((b) => (b.scope === 'parts') === (b.partIds !== undefined), {
    message: 'count.scope',
    path: ['partIds'],
  });

export const stockCountSchema = z.object({
  id: uuidSchema,
  locationId: uuidSchema,
  scope: z.enum(COUNT_SCOPES),
  categoryId: uuidSchema.nullable(),
  status: z.enum(COUNT_STATUSES),
  note: z.string().nullable(),
  createdAt: timestampSchema,
  createdBy: uuidSchema,
  closedAt: timestampSchema.nullable(),
  documentId: uuidSchema.nullable(),
  lines: z.int(),
  counted: z.int(),
});
export type StockCount = z.infer<typeof stockCountSchema>;

/** A count line. Counters never see `expected` or `variance` (blind count). */
export const countLineSchema = z.object({
  partId: uuidSchema,
  sku: z.string(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  counted: z.int().nullable(),
  countedAt: timestampSchema.nullable(),
  /** The location's quantity when the line was counted (approvers only). */
  expected: z.int().nullable().optional(),
  variance: z.int().nullable().optional(),
});
export type CountLine = z.infer<typeof countLineSchema>;

export const enterCountSchema = z.object({ counted: z.int().min(0).max(MAX_QUANTITY) });

export const approveCountSchema = z.object({
  /** The id of the stock document the approval posts (idempotent retries). */
  documentId: uuidV7Schema,
  /** Unit costs for gains of parts whose cost is not known yet. */
  costs: z
    .array(z.object({ partId: uuidSchema, unitCost: unitCostSchema }))
    .max(MAX_LINES)
    .optional(),
});

// --- review (ADR 0020) ---------------------------------------------------------------------

export const reviewItemSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['negative_stock', 'cost_unknown']),
  partId: uuidSchema,
  sku: z.string(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  locationId: uuidSchema.nullable(),
  moveId: uuidSchema,
  documentId: uuidSchema,
  /** The location's quantity now (negative_stock items). */
  quantity: z.int().nullable(),
  openedAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
  resolvedBy: uuidSchema.nullable(),
  resolutionNote: z.string().nullable(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const listReviewItemsQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const resolveReviewItemSchema = z.object({
  note: noteSchema,
  documentId: uuidSchema.optional(),
});
