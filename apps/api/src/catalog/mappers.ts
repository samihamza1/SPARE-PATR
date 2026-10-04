import type { DB } from '@autoparts/db';
import { QUALITY_GRADES, dec, formatFixed } from '@autoparts/shared';
import type { PartSummary, QualityGrade, Vehicle } from '@autoparts/shared';
import type { Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

export type Trx = Transaction<DB>;

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export const PART_COLUMNS = [
  'id',
  'sku',
  'name_ar',
  'name_en',
  'quality_grade',
  'brand_id',
  'category_id',
  'unit',
  'archived_at',
] as const;

type PartRow = Pick<Selectable<DB['parts']>, (typeof PART_COLUMNS)[number]>;

export function toPartSummary(row: PartRow): PartSummary {
  return {
    id: row.id,
    sku: row.sku,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    qualityGrade: row.quality_grade as QualityGrade | null,
    brandId: row.brand_id,
    categoryId: row.category_id,
    unit: row.unit,
    archivedAt: iso(row.archived_at),
  };
}

/** Best grade first; ungraded parts last. */
export function gradeRank(grade: string | null): number {
  const i = QUALITY_GRADES.indexOf(grade as QualityGrade);
  return i === -1 ? QUALITY_GRADES.length : i;
}

export function toVehicle(row: Selectable<DB['vehicles']>): Vehicle {
  return {
    id: row.id,
    parentId: row.parent_id,
    level: row.level as Vehicle['level'],
    name: row.name,
    nameAr: row.name_ar,
    yearFrom: row.year_from,
    yearTo: row.year_to,
    engineCode: row.engine_code,
    displacementCc: row.displacement_cc,
    fuel: row.fuel as Vehicle['fuel'],
    isLocal: row.tenant_id !== null,
    archivedAt: iso(row.archived_at),
  };
}

/** Names from the root down to each vehicle (only rows visible to this tenant). */
export async function vehiclePaths(
  trx: Trx,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ start: string; path: string[] }>`
    WITH RECURSIVE up AS (
      SELECT v.id AS start, v.parent_id, v.name, 0 AS depth FROM vehicles v WHERE v.id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT up.start, p.parent_id, p.name, up.depth + 1 FROM vehicles p JOIN up ON p.id = up.parent_id
    )
    SELECT start, array_agg(name ORDER BY depth DESC) AS path FROM up GROUP BY start`.execute(trx);
  return new Map(rows.map((r) => [r.start, r.path]));
}

/** Default price list for a currency (one per currency at most). */
export async function defaultPriceList(trx: Trx, currency: string) {
  return trx
    .selectFrom('price_lists')
    .select(['id', 'currency'])
    .where('currency', '=', currency)
    .where('is_default', '=', true)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
}

/**
 * Current price per part in a list: the latest entry already in effect, formatted at the
 * list currency's minor units (e.g. "12.50").
 */
export async function currentPrices(
  trx: Trx,
  priceListId: string,
  partIds: readonly string[],
  now: Date,
): Promise<Map<string, string>> {
  if (partIds.length === 0) return new Map();
  const { rows } = await sql<{ part_id: string; price: string; minor_units: number }>`
    SELECT DISTINCT ON (pp.part_id) pp.part_id, pp.price::text AS price, c.minor_units
      FROM part_prices pp
      JOIN price_lists l ON l.tenant_id = pp.tenant_id AND l.id = pp.price_list_id
      JOIN tenant_currencies c ON c.tenant_id = l.tenant_id AND c.code = l.currency
     WHERE pp.price_list_id = ${priceListId} AND pp.part_id = ANY(${partIds}::uuid[])
       AND pp.effective_at <= ${now}
     ORDER BY pp.part_id, pp.effective_at DESC, pp.recorded_at DESC`.execute(trx);
  return new Map(rows.map((r) => [r.part_id, formatFixed(dec(r.price), r.minor_units)]));
}

/** LIKE pattern for a literal substring. */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
