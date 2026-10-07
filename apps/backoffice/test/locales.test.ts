import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ERROR_CODES,
  PERMISSIONS,
  addFitmentSchema,
  addPartNumberSchema,
  bulkUpdatePartsSchema,
  changeOwnPasswordSchema,
  createAliasSchema,
  createBrandSchema,
  createCategorySchema,
  createCurrencySchema,
  createDeviceSchema,
  createImportSchema,
  createPartSchema,
  createPriceListSchema,
  createRoleSchema,
  createUserSchema,
  createVehicleSchema,
  grantRoleSchema,
  inspectImportSchema,
  linkInterchangeSchema,
  loginRequestSchema,
  resetPasswordSchema,
  setPriceSchema,
  skipImportRowsSchema,
  adjustmentRequestSchema,
  approveCountSchema,
  createCountSchema,
  createFxRateSchema,
  createLocationSchema,
  createOpeningSchema,
  enterCountSchema,
  partTransferRequestSchema,
  resolveReviewItemSchema,
  setDeviceLocationSchema,
  transferRequestSchema,
  updateLocationSchema,
  updateOpeningLineSchema,
  updateOpeningSchema,
  supersedeSchema,
  updateBrandSchema,
  updateCategorySchema,
  updateCurrencySchema,
  updatePartSchema,
  updatePriceListSchema,
  updateRoleSchema,
  updateSettingsSchema,
  updateUserSchema,
  updateVehicleSchema,
} from '@autoparts/shared';
import { describe, expect, it } from 'vitest';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';

function keys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function values(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return [node];
  return Object.values(node).flatMap(values);
}

const has = (locale: unknown, key: string): boolean =>
  typeof key
    .split('.')
    .reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], locale) ===
  'string';

/** Message keys (such as "sku.invalid") the shared zod schemas put on validation issues. */
function sharedMessageKeys(): string[] {
  const root = join(import.meta.dirname, '../../../packages/shared/src');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  return files.flatMap((f) =>
    [
      ...readFileSync(join(root, f), 'utf8').matchAll(/message:\s*'([a-z_]+(?:\.[a-z0-9_]+)+)'/g),
    ].map((m) => m[1]!),
  );
}

interface ZodLike {
  _zod: { def: Record<string, unknown> & { type: string } };
}

/** Every object key in a zod schema, at any depth (the names of the request fields). */
function fieldNames(schema: ZodLike): string[] {
  const def = schema._zod.def;
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape as Record<string, ZodLike>).flatMap(([k, v]) => [
        k,
        ...fieldNames(v),
      ]);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return fieldNames(def.innerType as ZodLike);
    case 'pipe':
      return [...fieldNames(def.in as ZodLike), ...fieldNames(def.out as ZodLike)];
    case 'array':
      return fieldNames(def.element as ZodLike);
    case 'record':
      return [...fieldNames(def.keyType as ZodLike), ...fieldNames(def.valueType as ZodLike)];
    case 'enum':
      // Record keys such as the import's column fields.
      return [];
    default:
      return [];
  }
}

/** Request bodies the back office sends; their fields can come back in validation issues. */
const REQUEST_SCHEMAS = [
  loginRequestSchema,
  changeOwnPasswordSchema,
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  grantRoleSchema,
  createRoleSchema,
  updateRoleSchema,
  updateSettingsSchema,
  createCurrencySchema,
  updateCurrencySchema,
  createDeviceSchema,
  createBrandSchema,
  updateBrandSchema,
  createCategorySchema,
  updateCategorySchema,
  createVehicleSchema,
  updateVehicleSchema,
  createAliasSchema,
  addPartNumberSchema,
  createPartSchema,
  updatePartSchema,
  bulkUpdatePartsSchema,
  addFitmentSchema,
  supersedeSchema,
  linkInterchangeSchema,
  createPriceListSchema,
  updatePriceListSchema,
  setPriceSchema,
  inspectImportSchema,
  createImportSchema,
  skipImportRowsSchema,
  adjustmentRequestSchema,
  approveCountSchema,
  createCountSchema,
  createFxRateSchema,
  createLocationSchema,
  createOpeningSchema,
  enterCountSchema,
  partTransferRequestSchema,
  resolveReviewItemSchema,
  setDeviceLocationSchema,
  transferRequestSchema,
  updateLocationSchema,
  updateOpeningLineSchema,
  updateOpeningSchema,
] as unknown as ZodLike[];

describe('locales', () => {
  it('Arabic and English define the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it('has no empty translations', () => {
    for (const value of [...values(ar), ...values(en)]) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
  });

  it('labels every permission in both languages', () => {
    for (const locale of [ar, en]) {
      const labels = keys(locale.permissions);
      expect(labels.sort()).toEqual([...PERMISSIONS].sort());
    }
  });

  it('explains every error code the API can send, in both languages', () => {
    for (const locale of [ar, en]) {
      const missing = [...ERROR_CODES, 'network'].filter((c) => !has(locale.errors, c));
      expect(missing).toEqual([]);
    }
  });

  it('translates every validation message the shared schemas use', () => {
    const messages = sharedMessageKeys();
    expect(messages.length).toBeGreaterThan(5);
    for (const locale of [ar, en]) {
      expect(messages.filter((m) => !has(locale.validation, m))).toEqual([]);
    }
  });

  it('labels every request field, so a validation issue never shows a raw field path', () => {
    const fields = [...new Set(REQUEST_SCHEMAS.flatMap(fieldNames))];
    expect(fields).toContain('priceListId');
    for (const locale of [ar, en]) {
      // Flat labels: an issue path such as "mapping.priceListId" is labelled by its last part.
      expect(Object.values(locale.fields).every((v) => typeof v === 'string')).toBe(true);
      expect(fields.filter((f) => !has(locale.fields, f))).toEqual([]);
    }
  });
});
