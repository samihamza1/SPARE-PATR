import { z } from 'zod';
import { normalizePartNumber } from '../catalog/normalize';
import { partSummarySchema } from '../catalog/schemas';
import { uuidSchema, uuidV7Schema } from '../ids';
import { currencyCodeSchema } from '../money';
import { requireChange } from '../patch';

const timestampSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(120);
const phoneSchema = z.string().trim().min(1).max(40);
const noteSchema = z.string().trim().min(1).max(500);

/**
 * A number as printed on a supplier's invoice. It must keep at least one letter or digit
 * once spaces and separators are removed (the database stores that form, ADR 0026).
 */
export const supplierNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((s) => normalizePartNumber(s) !== '', { message: 'supplier_part.empty_number' });

// --- suppliers (ADR 0026) -----------------------------------------------------------------

export const supplierSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  defaultCurrency: currencyCodeSchema.nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  archivedAt: timestampSchema.nullable(),
});
export type Supplier = z.infer<typeof supplierSchema>;

export const createSupplierSchema = z.object({
  id: uuidV7Schema,
  name: nameSchema,
  defaultCurrency: currencyCodeSchema.nullish(),
  phone: phoneSchema.nullish(),
  note: noteSchema.nullish(),
});
export type CreateSupplier = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = requireChange(
  z
    .object({
      name: nameSchema,
      defaultCurrency: currencyCodeSchema.nullable(),
      phone: phoneSchema.nullable(),
      note: noteSchema.nullable(),
      archived: z.boolean(),
    })
    .partial(),
);

export const listSuppliersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  includeArchived: z.stringbool().optional(),
});

// --- supplier part numbers ----------------------------------------------------------------

export const supplierPartSchema = z.object({
  id: uuidSchema,
  supplierId: uuidSchema,
  number: z.string(),
  part: partSummarySchema,
  createdAt: timestampSchema,
});
export type SupplierPart = z.infer<typeof supplierPartSchema>;

export const addSupplierPartSchema = z.object({
  id: uuidV7Schema,
  partId: uuidSchema,
  number: supplierNumberSchema,
});

export const listSupplierPartsQuerySchema = z.object({
  /** Matches the supplier number (part-number form) or the part's SKU or name. */
  q: z.string().trim().max(120).optional(),
  partId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const supplierPartPageSchema = z.object({
  items: z.array(supplierPartSchema),
  total: z.int(),
});
export type SupplierPartPage = z.infer<typeof supplierPartPageSchema>;

export const MAX_RESOLVE_NUMBERS = 500;

/** Supplier numbers to look up, e.g. every line of an invoice being keyed in. */
export const resolveSupplierNumbersSchema = z.object({
  numbers: z.array(supplierNumberSchema).min(1).max(MAX_RESOLVE_NUMBERS),
});

/**
 * How a supplier number resolves, exact matches only (the system never guesses, ADR 0016):
 * - remembered: this supplier's saved mapping. When that part is archived, `replacement` is
 *   the part that replaces it today (or null), and the mapping should be updated;
 * - candidates: no mapping, but active parts carry this number (catalog number or SKU); the
 *   user picks one, even when there is only one;
 * - none: nothing matches.
 */
export const SUPPLIER_NUMBER_STATUSES = ['remembered', 'candidates', 'none'] as const;
export type SupplierNumberStatus = (typeof SUPPLIER_NUMBER_STATUSES)[number];

export const resolvedSupplierNumberSchema = z.object({
  number: z.string(),
  status: z.enum(SUPPLIER_NUMBER_STATUSES),
  mapping: z
    .object({
      id: uuidSchema,
      part: partSummarySchema,
      replacement: partSummarySchema.nullable(),
    })
    .nullable(),
  candidates: z.array(partSummarySchema),
});
export type ResolvedSupplierNumber = z.infer<typeof resolvedSupplierNumberSchema>;

export const resolveSupplierNumbersResponseSchema = z.object({
  results: z.array(resolvedSupplierNumberSchema),
});
export type ResolveSupplierNumbersResponse = z.infer<typeof resolveSupplierNumbersResponseSchema>;
