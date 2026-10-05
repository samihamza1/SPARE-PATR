import { z } from 'zod';
import { uuidSchema, uuidV7Schema } from '../ids';
import { currencyCodeSchema } from '../money';
import { PART_NUMBER_KINDS } from './schemas';

/** Largest accepted upload (bytes) and sheet size; sanity limits, not business rules. */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;
export const IMPORT_MAX_COLUMNS = 100;

/** Spreadsheet columns the import understands (ADR 0016). */
export const IMPORT_FIELDS = [
  'sku',
  'partNumber',
  'nameEn',
  'nameAr',
  'vehicleCode',
  'sellPrice',
  'cost',
  'quantity',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Row problems shown in the preview. Blocking ones make the row skipped; the others are
 * warnings or information and the row is still imported.
 */
export const IMPORT_ISSUES = [
  // blocking
  'empty_row',
  'no_name',
  'bad_sku',
  'sku_taken',
  // warnings: imported, but something is missing or was changed
  'no_part_number',
  'no_price',
  'zero_price',
  'bad_price',
  'price_rounded',
  'bad_cost',
  'bad_quantity',
  'vehicle_unmapped',
  'price_conflict',
  // information
  'duplicate_row',
  'shared_number',
  'existing_part',
] as const;
export type ImportIssue = (typeof IMPORT_ISSUES)[number];
export const BLOCKING_IMPORT_ISSUES: readonly ImportIssue[] = [
  'empty_row',
  'no_name',
  'bad_sku',
  'sku_taken',
];

/**
 * create: new part; update: a part from an earlier import with the same row identity
 * (its price is refreshed); merge: a repeat of an earlier row in this file (same part);
 * skip: not imported.
 */
export const IMPORT_DECISIONS = ['create', 'update', 'merge', 'skip'] as const;
export type ImportDecision = (typeof IMPORT_DECISIONS)[number];

export const IMPORT_STATUSES = ['draft', 'previewed', 'applied', 'discarded'] as const;

const fileSchema = {
  fileName: z.string().trim().min(1).max(255),
  /** File bytes, base64. */
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(IMPORT_MAX_FILE_BYTES / 3) * 4),
};
export const inspectImportSchema = z.object(fileSchema);

export type ImportCell = string | null;
export const importSheetPreviewSchema = z.object({
  name: z.string(),
  rowCount: z.int(),
  columnCount: z.int(),
  /** The first rows as text, for choosing the header row and the columns. */
  rows: z.array(z.array(z.string().nullable())),
});
export const inspectImportResultSchema = z.object({
  sheets: z.array(importSheetPreviewSchema),
});
export type InspectImportResult = z.infer<typeof inspectImportResultSchema>;

const columnIndex = z
  .int()
  .min(0)
  .max(IMPORT_MAX_COLUMNS - 1);
export const importMappingSchema = z
  .object({
    /** Field -> zero-based column index in the sheet. */
    columns: z.partialRecord(z.enum(IMPORT_FIELDS), columnIndex),
    /** What the part-number column holds; the shop decides, the import never guesses. */
    numberKind: z.enum(PART_NUMBER_KINDS),
    /** Price list for the sell-price column (its currency is the price currency). */
    priceListId: uuidSchema.nullish(),
    /** Currency of the cost column; kept for the opening-stock step (Sprint 4). */
    costCurrency: currencyCodeSchema.nullish(),
    /** Generated SKUs are PREFIX-00001, PREFIX-00002, ... when no SKU column is mapped. */
    skuPrefix: z
      .string()
      .regex(/^[A-Z0-9]{1,10}$/)
      .nullish(),
  })
  .refine(
    (m) =>
      m.columns.partNumber !== undefined ||
      m.columns.nameEn !== undefined ||
      m.columns.nameAr !== undefined,
    {
      message: 'import.mapping_needs_identity',
      path: ['columns'],
    },
  )
  .refine((m) => m.columns.sellPrice === undefined || m.priceListId != null, {
    message: 'import.mapping_needs_price_list',
    path: ['priceListId'],
  })
  .refine((m) => m.columns.cost === undefined || m.costCurrency != null, {
    message: 'import.mapping_needs_cost_currency',
    path: ['costCurrency'],
  })
  .refine((m) => m.columns.sku !== undefined || m.skuPrefix != null, {
    message: 'import.mapping_needs_sku',
    path: ['skuPrefix'],
  })
  .refine((m) => new Set(Object.values(m.columns)).size === Object.values(m.columns).length, {
    message: 'import.mapping_duplicate_column',
    path: ['columns'],
  });
export type ImportMapping = z.infer<typeof importMappingSchema>;

export const createImportSchema = z.object({
  id: uuidV7Schema,
  ...fileSchema,
  sheet: z.string().min(1).max(100),
  /** 1-based row holding the column titles; data starts on the next row. */
  headerRow: z.int().min(1).max(1000),
  mapping: importMappingSchema,
});

/** Values read from one row, after cleaning (decimal strings, trimmed text). */
export const parsedImportRowSchema = z.object({
  sku: z.string().optional(),
  partNumber: z.string().optional(),
  partNumberNorm: z.string().optional(),
  nameEn: z.string().optional(),
  nameAr: z.string().optional(),
  vehicleCode: z.string().optional(),
  vehicleCodeNorm: z.string().optional(),
  /** Rounded to the price list currency. */
  sellPrice: z.string().optional(),
  sellPriceRaw: z.string().optional(),
  cost: z.string().optional(),
  quantity: z.string().optional(),
});
export type ParsedImportRow = z.infer<typeof parsedImportRowSchema>;

export const importRowSchema = z.object({
  id: uuidSchema,
  rowNumber: z.int(),
  parsed: parsedImportRowSchema,
  issues: z.array(z.enum(IMPORT_ISSUES)),
  decision: z.enum(IMPORT_DECISIONS).nullable(),
  skippedByUser: z.boolean(),
  partId: uuidSchema.nullable(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importStatsSchema = z.object({
  rows: z.int(),
  byDecision: z.partialRecord(z.enum(IMPORT_DECISIONS), z.int()),
  byIssue: z.partialRecord(z.enum(IMPORT_ISSUES), z.int()),
  pricesSet: z.int().optional(),
  fitmentsAdded: z.int().optional(),
});
export type ImportStats = z.infer<typeof importStatsSchema>;

export const importVehicleCodeSchema = z.object({
  code: z.string(),
  codeNorm: z.string(),
  rows: z.int(),
  /** How the code is mapped today (tenant vehicle aliases), or null when unmapped. */
  mapping: z
    .object({
      target: z.enum(['vehicle', 'category', 'ignore']),
      vehicleIds: z.array(uuidSchema),
      categoryId: uuidSchema.nullable(),
    })
    .nullable(),
});

export const importBatchSchema = z.object({
  id: uuidSchema,
  fileName: z.string(),
  sheet: z.string().nullable(),
  headerRow: z.int().nullable(),
  status: z.enum(IMPORT_STATUSES),
  mapping: importMappingSchema.nullable(),
  stats: importStatsSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  appliedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;
export const importBatchDetailSchema = importBatchSchema.extend({
  vehicleCodes: z.array(importVehicleCodeSchema),
});
export type ImportBatchDetail = z.infer<typeof importBatchDetailSchema>;

export const listImportRowsQuerySchema = z.object({
  issue: z.enum(IMPORT_ISSUES).optional(),
  decision: z.enum(IMPORT_DECISIONS).optional(),
  /** Keyset pagination on row number. */
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const skipImportRowsSchema = z.object({
  rowIds: z.array(uuidSchema).min(1).max(1000),
  skipped: z.boolean(),
});
