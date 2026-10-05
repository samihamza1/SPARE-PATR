import {
  BLOCKING_IMPORT_ISSUES,
  Decimal,
  formatFixed,
  normalizePartNumber,
  normalizeSearchText,
  round,
  skuSchema,
  toDecimalString,
} from '@autoparts/shared';
import type {
  ImportCell,
  ImportDecision,
  ImportField,
  ImportIssue,
  ImportMapping,
  ParsedImportRow,
  RoundingMode,
} from '@autoparts/shared';

/** The mapped cells of one row, by field. Only these are stored (ADR 0016). */
export type RawImportRow = Partial<Record<ImportField, string | null>>;

export function extractRaw(row: readonly ImportCell[], mapping: ImportMapping): RawImportRow {
  const raw: RawImportRow = {};
  for (const [field, index] of Object.entries(mapping.columns) as [ImportField, number][]) {
    raw[field] = row[index] ?? null;
  }
  return raw;
}

export interface PriceSpec {
  minorUnits: number;
  roundingMode: RoundingMode;
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

/** Text to a non-negative decimal, or null if it is not one. No guessing of separators. */
export function parseQuantityText(text: string): Decimal | null {
  const ascii = text
    .trim()
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - (d >= '\u06f0' ? 0x06f0 : 0x0660)))
    .replace('٫', '.');
  if (!DECIMAL_TEXT.test(ascii)) return null;
  return new Decimal(ascii);
}

const MAX_NAME = 200;
const MAX_NUMBER = 60;

const text = (value: string | null | undefined): string | undefined => {
  const t = value?.replace(/\s+/g, ' ').trim();
  return t === undefined || t === '' ? undefined : t;
};

export interface ParsedRow {
  parsed: ParsedImportRow;
  issues: ImportIssue[];
  rowKey: string | null;
}

/**
 * Cleans one row. Selling prices are rounded to the price list currency with the tenant
 * rounding mode (and flagged when that changed them); cost and quantity are kept as read.
 */
export function parseRow(raw: RawImportRow, price: PriceSpec | null): ParsedRow {
  const issues: ImportIssue[] = [];
  const parsed: ParsedImportRow = {};

  const values = Object.values(raw).map((v) => text(v));
  if (values.every((v) => v === undefined)) {
    return { parsed, issues: ['empty_row'], rowKey: null };
  }

  const sku = text(raw.sku);
  if (sku !== undefined) {
    parsed.sku = sku;
    if (!skuSchema.safeParse(sku).success) issues.push('bad_sku');
  }

  const number = text(raw.partNumber);
  const numberNorm = number === undefined ? '' : normalizePartNumber(number);
  if (number !== undefined && numberNorm !== '' && number.length <= MAX_NUMBER) {
    parsed.partNumber = number;
    parsed.partNumberNorm = numberNorm;
  } else {
    issues.push('no_part_number');
  }

  const nameEn = text(raw.nameEn)?.slice(0, MAX_NAME);
  const nameAr = text(raw.nameAr)?.slice(0, MAX_NAME);
  if (nameEn !== undefined) parsed.nameEn = nameEn;
  if (nameAr !== undefined) parsed.nameAr = nameAr;
  if (nameEn === undefined && nameAr === undefined) issues.push('no_name');

  const vehicle = text(raw.vehicleCode);
  if (vehicle !== undefined) {
    const norm = normalizeSearchText(vehicle);
    if (norm !== '') {
      parsed.vehicleCode = vehicle;
      parsed.vehicleCodeNorm = norm;
    }
  }

  if ('sellPrice' in raw) {
    const priceText = text(raw.sellPrice);
    const value = priceText === undefined ? null : parseQuantityText(priceText);
    if (priceText === undefined) issues.push('no_price');
    else if (value === null) issues.push('bad_price');
    else if (value.isZero()) issues.push('zero_price');
    else if (price !== null) {
      const rounded = round(value, price.minorUnits, price.roundingMode);
      parsed.sellPriceRaw = toDecimalString(value);
      parsed.sellPrice = formatFixed(rounded, price.minorUnits);
      if (!rounded.eq(value)) issues.push('price_rounded');
    }
  }

  const cost = text(raw.cost);
  if (cost !== undefined) {
    const value = parseQuantityText(cost);
    if (value === null) issues.push('bad_cost');
    else parsed.cost = toDecimalString(value);
  }

  const quantity = text(raw.quantity);
  if (quantity !== undefined) {
    const value = parseQuantityText(quantity);
    if (value === null) issues.push('bad_quantity');
    else parsed.quantity = toDecimalString(value);
  }

  return { parsed, issues, rowKey: rowKeyOf(parsed) };
}

/**
 * Identity of a row across files: normalised part number, name and vehicle code. Two rows
 * with the same key are the same part; the plan's "same number + vehicle + name".
 */
export function rowKeyOf(parsed: ParsedImportRow): string | null {
  const name = parsed.nameEn ?? parsed.nameAr;
  if (name === undefined) return null;
  return [
    parsed.partNumberNorm ?? '',
    normalizeSearchText(name),
    parsed.vehicleCodeNorm ?? '',
  ].join('|');
}

export interface AnalysisInput {
  rowNumber: number;
  parsed: ParsedImportRow;
  issues: ImportIssue[];
  rowKey: string | null;
  skippedByUser: boolean;
}

export interface AnalysisContext {
  /** Row keys from earlier applied imports -> the part they created. */
  priorParts: ReadonlyMap<string, string>;
  /** Normalised vehicle codes the tenant has mapped (vehicle_aliases). */
  mappedCodes: ReadonlySet<string>;
  /** Upper-case SKUs already used in the tenant. */
  existingSkus: ReadonlySet<string>;
}

export interface AnalysedRow {
  decision: ImportDecision;
  issues: ImportIssue[];
  /** For update rows: the part from the earlier import. */
  partId: string | null;
}

/** Decides what applying would do with each row (ADR 0016). Pure, so it is unit-tested. */
export function analyseRows(rows: readonly AnalysisInput[], ctx: AnalysisContext): AnalysedRow[] {
  const keysByNumber = new Map<string, Set<string>>();
  for (const r of rows) {
    const n = r.parsed.partNumberNorm;
    if (n === undefined || r.rowKey === null) continue;
    keysByNumber.set(n, (keysByNumber.get(n) ?? new Set()).add(r.rowKey));
  }

  const firstByKey = new Map<string, ParsedImportRow>();
  const skuOwner = new Map<string, string>();
  return rows.map((r) => {
    const issues = [...r.issues];
    const code = r.parsed.vehicleCodeNorm;
    if (code !== undefined && !ctx.mappedCodes.has(code)) issues.push('vehicle_unmapped');
    const number = r.parsed.partNumberNorm;
    if (number !== undefined && (keysByNumber.get(number)?.size ?? 0) > 1) {
      issues.push('shared_number');
    }
    const prior = r.rowKey === null ? undefined : ctx.priorParts.get(r.rowKey);
    if (prior !== undefined) issues.push('existing_part');

    const sku = r.parsed.sku?.toUpperCase();
    if (sku !== undefined && prior === undefined && r.rowKey !== null) {
      const owner = skuOwner.get(sku);
      if (ctx.existingSkus.has(sku) || (owner !== undefined && owner !== r.rowKey)) {
        issues.push('sku_taken');
      }
    }

    const blocked = issues.some((i) => BLOCKING_IMPORT_ISSUES.includes(i));
    if (blocked || r.skippedByUser || r.rowKey === null) {
      return { decision: 'skip', issues, partId: null };
    }
    if (sku !== undefined) skuOwner.set(sku, r.rowKey);

    // A repeat within this file joins its first occurrence, whatever that one does, so
    // one part never gets two prices from one file.
    const first = firstByKey.get(r.rowKey);
    if (first !== undefined) {
      issues.push('duplicate_row');
      if (first.sellPrice !== r.parsed.sellPrice) issues.push('price_conflict');
      return { decision: 'merge', issues, partId: prior ?? null };
    }
    firstByKey.set(r.rowKey, r.parsed);
    if (prior !== undefined) return { decision: 'update', issues, partId: prior };
    return { decision: 'create', issues, partId: null };
  });
}
