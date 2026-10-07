import { z } from 'zod';
import { uuidSchema, uuidV7Schema } from '../ids';
import { currencyCodeSchema, decimalStringSchema } from '../money';
import { requireChange } from '../patch';

/** BRIEF quality grades, best first. `null` on a part means "not graded yet". */
export const QUALITY_GRADES = ['oem', 'premium', 'good', 'economy'] as const;
export type QualityGrade = (typeof QUALITY_GRADES)[number];
export const qualityGradeSchema = z.enum(QUALITY_GRADES);

export const VEHICLE_LEVELS = ['type', 'make', 'model', 'generation', 'engine'] as const;
export type VehicleLevel = (typeof VEHICLE_LEVELS)[number];
export const FUELS = ['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'cng'] as const;
export const PART_NUMBER_KINDS = ['oem', 'aftermarket', 'other'] as const;
export const BRAND_KINDS = ['vehicle_maker', 'aftermarket'] as const;

const nameSchema = z.string().trim().min(1).max(200);
const shortNameSchema = z.string().trim().min(1).max(100);
const timestampSchema = z.iso.datetime({ offset: true });
const yearSchema = z.int().min(1900).max(2100);

// --- brands, categories, vehicles, aliases ----------------------------------------------

export const brandSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  kind: z.enum(BRAND_KINDS),
  archivedAt: timestampSchema.nullable(),
});
export type Brand = z.infer<typeof brandSchema>;
export const createBrandSchema = z.object({
  id: uuidV7Schema,
  name: shortNameSchema,
  kind: z.enum(BRAND_KINDS),
});
export const updateBrandSchema = requireChange(
  z.object({ name: shortNameSchema, kind: z.enum(BRAND_KINDS), archived: z.boolean() }).partial(),
);

export const categorySchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  archivedAt: timestampSchema.nullable(),
});
export type Category = z.infer<typeof categorySchema>;
const categoryNames = {
  nameAr: shortNameSchema.nullish(),
  nameEn: shortNameSchema.nullish(),
};
export const createCategorySchema = z
  .object({ id: uuidV7Schema, parentId: uuidSchema.nullish(), ...categoryNames })
  .refine((c) => c.nameAr != null || c.nameEn != null, {
    message: 'name.required',
    path: ['nameAr'],
  });
export const updateCategorySchema = requireChange(
  z.object({ ...categoryNames, parentId: uuidSchema.nullable(), archived: z.boolean() }).partial(),
);

export const vehicleSchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable(),
  level: z.enum(VEHICLE_LEVELS),
  name: z.string(),
  nameAr: z.string().nullable(),
  yearFrom: z.int().nullable(),
  yearTo: z.int().nullable(),
  engineCode: z.string().nullable(),
  displacementCc: z.int().nullable(),
  fuel: z.enum(FUELS).nullable(),
  /** true for this tenant's own additions, false for platform rows. */
  isLocal: z.boolean(),
  archivedAt: timestampSchema.nullable(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;
export const createVehicleSchema = z.object({
  id: uuidV7Schema,
  parentId: uuidSchema,
  level: z.enum(VEHICLE_LEVELS).exclude(['type']),
  name: shortNameSchema,
  nameAr: shortNameSchema.nullish(),
  yearFrom: yearSchema.nullish(),
  yearTo: yearSchema.nullish(),
  engineCode: z.string().trim().min(1).max(30).nullish(),
  displacementCc: z.int().positive().nullish(),
  fuel: z.enum(FUELS).nullish(),
});
export const updateVehicleSchema = requireChange(
  createVehicleSchema
    .omit({ id: true, parentId: true, level: true })
    .extend({ archived: z.boolean() })
    .partial(),
);

export const ALIAS_TARGETS = ['vehicle', 'category', 'ignore'] as const;
export const aliasSchema = z.object({
  id: uuidSchema,
  alias: z.string(),
  target: z.enum(ALIAS_TARGETS),
  vehicleId: uuidSchema.nullable(),
  vehicleName: z.string().nullable(),
  categoryId: uuidSchema.nullable(),
});
export type VehicleAlias = z.infer<typeof aliasSchema>;
export const createAliasSchema = z
  .object({
    id: uuidV7Schema,
    alias: z.string().trim().min(1).max(60),
    target: z.enum(ALIAS_TARGETS),
    vehicleId: uuidSchema.nullish(),
    categoryId: uuidSchema.nullish(),
  })
  .refine(
    (a) =>
      (a.target === 'vehicle') === (a.vehicleId != null) &&
      (a.target === 'category') === (a.categoryId != null),
    { message: 'alias.target_mismatch', path: ['target'] },
  );

// --- parts ------------------------------------------------------------------------------

export const partNumberSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  numberNorm: z.string(),
  kind: z.enum(PART_NUMBER_KINDS),
  brandId: uuidSchema.nullable(),
});
export type PartNumber = z.infer<typeof partNumberSchema>;
export const addPartNumberSchema = z.object({
  id: uuidV7Schema,
  number: z.string().trim().min(1).max(60),
  kind: z.enum(PART_NUMBER_KINDS),
  brandId: uuidSchema.nullish(),
});

export const partSummarySchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  qualityGrade: qualityGradeSchema.nullable(),
  brandId: uuidSchema.nullable(),
  categoryId: uuidSchema.nullable(),
  unit: z.string(),
  archivedAt: timestampSchema.nullable(),
});
export type PartSummary = z.infer<typeof partSummarySchema>;

export const skuSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/, { message: 'sku.invalid' });
const unitSchema = z.string().regex(/^[a-z][a-z_]{0,19}$/);

export const createPartSchema = z
  .object({
    id: uuidV7Schema,
    sku: skuSchema,
    nameAr: nameSchema.nullish(),
    nameEn: nameSchema.nullish(),
    qualityGrade: qualityGradeSchema.nullish(),
    brandId: uuidSchema.nullish(),
    categoryId: uuidSchema.nullish(),
    unit: unitSchema.optional(),
    notes: z.string().max(2000).nullish(),
    numbers: z.array(addPartNumberSchema).max(50).optional(),
  })
  .refine((p) => p.nameAr != null || p.nameEn != null, {
    message: 'name.required',
    path: ['nameAr'],
  });

export const updatePartSchema = requireChange(
  z
    .object({
      sku: skuSchema,
      nameAr: nameSchema.nullable(),
      nameEn: nameSchema.nullable(),
      qualityGrade: qualityGradeSchema.nullable(),
      brandId: uuidSchema.nullable(),
      categoryId: uuidSchema.nullable(),
      unit: unitSchema,
      notes: z.string().max(2000).nullable(),
      archived: z.boolean(),
    })
    .partial(),
);

/** Bulk edit for the "needs review" list (e.g. grade 300 imported parts at once). */
export const bulkUpdatePartsSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(500),
  set: z
    .object({
      qualityGrade: qualityGradeSchema.nullable(),
      brandId: uuidSchema.nullable(),
      categoryId: uuidSchema.nullable(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'bulk.nothing_to_set' }),
});

export const NEEDS_REVIEW = ['ungraded', 'no_price', 'no_fitment'] as const;
export const listPartsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  needsReview: z.enum(NEEDS_REVIEW).optional(),
  brandId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  includeArchived: z.stringbool().optional(),
  /** Keyset pagination on SKU. */
  after: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const fitmentSchema = z.object({
  id: uuidSchema,
  vehicleId: uuidSchema,
  /** Names from the root to the vehicle, e.g. ["Car", "Toyota", "Land Cruiser"]. */
  path: z.array(z.string()),
  note: z.string().nullable(),
});
export const addFitmentSchema = z.object({
  id: uuidV7Schema,
  vehicleId: uuidSchema,
  note: z.string().max(500).nullish(),
});

export const supersedeSchema = z.object({
  id: uuidV7Schema,
  newPartId: uuidSchema,
  effectiveAt: timestampSchema.optional(),
  reason: z.string().max(500).nullish(),
});
/** Ends a wrong or outdated supersession; the links it copied may be removed with it. */
export const removeSupersessionSchema = z.object({
  removeCopiedFitments: z.boolean().default(false),
  reason: z.string().trim().max(500).nullish(),
});

export const linkInterchangeSchema = z.object({ partId: uuidSchema });

// --- prices -----------------------------------------------------------------------------

export const priceListSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  currency: currencyCodeSchema,
  isDefault: z.boolean(),
  archivedAt: timestampSchema.nullable(),
});
export type PriceList = z.infer<typeof priceListSchema>;
export const createPriceListSchema = z.object({
  id: uuidV7Schema,
  name: shortNameSchema,
  currency: currencyCodeSchema,
  isDefault: z.boolean().optional(),
});
export const updatePriceListSchema = requireChange(
  z.object({ name: shortNameSchema, isDefault: z.boolean(), archived: z.boolean() }).partial(),
);

export const setPriceSchema = z.object({
  id: uuidV7Schema,
  partId: uuidSchema,
  /** Decimal string; must not have more decimals than the list currency allows. */
  price: decimalStringSchema.refine((s) => !s.startsWith('-'), { message: 'price.negative' }),
  effectiveAt: timestampSchema.optional(),
  reason: z.string().max(500).nullish(),
});

export const priceEntrySchema = z.object({
  id: uuidSchema,
  priceListId: uuidSchema,
  price: decimalStringSchema,
  currency: currencyCodeSchema,
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  recordedBy: uuidSchema.nullable(),
  source: z.enum(['manual', 'import']),
  reason: z.string().nullable(),
});
export type PriceEntry = z.infer<typeof priceEntrySchema>;

export const currentPriceSchema = z.object({
  amount: decimalStringSchema,
  currency: currencyCodeSchema,
});

export const partDetailSchema = partSummarySchema.extend({
  notes: z.string().nullable(),
  numbers: z.array(partNumberSchema),
  fitments: z.array(fitmentSchema),
  interchange: z.array(partSummarySchema),
  supersededBy: partSummarySchema.nullable(),
  supersedes: z.array(partSummarySchema),
  /** Current price in each active list. */
  prices: z.array(z.object({ priceListId: uuidSchema, current: currentPriceSchema.nullable() })),
});
export type PartDetail = z.infer<typeof partDetailSchema>;

// --- search -----------------------------------------------------------------------------

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  vehicleId: uuidSchema.optional(),
  /** Price currency; defaults to the tenant's functional currency. */
  currency: currencyCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const ALTERNATIVE_RELATIONS = ['interchange', 'shared_number', 'replacement'] as const;
export const searchHitSchema = z.object({
  part: partSummarySchema,
  price: currentPriceSchema.nullable(),
});
export const searchResultSchema = z.object({
  interpretation: z.object({
    text: z.array(z.string()),
    year: z.int().nullable(),
    partNumber: z.string().nullable(),
    vehicles: z.array(
      z.object({ id: uuidSchema, name: z.string(), level: z.enum(VEHICLE_LEVELS) }),
    ),
  }),
  results: z.array(
    searchHitSchema.extend({
      /** 'replacement': found through the number or SKU of an archived part it replaces. */
      matchedBy: z.enum(['number', 'replacement', 'text', 'vehicle']),
      alternatives: z.array(searchHitSchema.extend({ relation: z.enum(ALTERNATIVE_RELATIONS) })),
    }),
  ),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
