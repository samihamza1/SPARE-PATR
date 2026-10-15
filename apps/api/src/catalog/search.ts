import { dec, normalizePartNumber, normalizeSearchText } from '@autoparts/shared';
import type { SearchResult } from '@autoparts/shared';
import { sql } from 'kysely';
import type { Trx } from './mappers';
import {
  PART_COLUMNS,
  currentPrices,
  defaultPriceList,
  gradeRank,
  likeContains,
  likePrefix,
  toPartSummary,
} from './mappers';

export interface SearchInput {
  q: string;
  vehicleId?: string | undefined;
  currency?: string | undefined;
  limit: number;
}

const YEAR = /^(19|20)\d{2}$/;
const MAX_NGRAM = 3;

interface Interpretation {
  text: string[];
  year: number | null;
  partNumbers: string[];
}

/** Splits the query into year, part-number candidates and words (ADR 0015). */
export function interpret(q: string): Interpretation {
  const tokens = normalizeSearchText(q)
    .split(' ')
    .filter((t) => t !== '');
  const yearIndex = tokens.findIndex((t) => YEAR.test(t));
  const year = yearIndex === -1 ? null : Number.parseInt(tokens[yearIndex] ?? '', 10);
  const text = tokens.filter((_, i) => i !== yearIndex);
  const candidates = new Set<string>();
  const whole = normalizePartNumber(q);
  if (/\d/.test(whole) && whole.length >= 4 && !YEAR.test(whole)) candidates.add(whole);
  for (const t of text) {
    const n = normalizePartNumber(t);
    if (/\d/.test(n) && n.length >= 4) candidates.add(n);
  }
  return { text, year, partNumbers: [...candidates].slice(0, 8) };
}

/** Recognises vehicle words (aliases or names, longest phrase first) and removes them. */
async function detectVehicles(trx: Trx, words: string[]) {
  const grams = new Map<string, number[]>();
  for (let n = Math.min(MAX_NGRAM, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const key = words.slice(i, i + n).join(' ');
      if (!grams.has(key))
        grams.set(
          key,
          Array.from({ length: n }, (_, k) => i + k),
        );
    }
  }
  if (grams.size === 0) return { vehicleIds: [] as string[], rest: words };
  const keys = [...grams.keys()];
  const { rows } = await sql<{ key: string; id: string }>`
    SELECT alias_norm AS key, vehicle_id AS id FROM vehicle_aliases
     WHERE target = 'vehicle' AND removed_at IS NULL AND alias_norm = ANY(${keys}::text[])
    UNION ALL
    SELECT normalize_search(name), id FROM vehicles
     WHERE archived_at IS NULL AND level <> 'type' AND normalize_search(name) = ANY(${keys}::text[])
    UNION ALL
    SELECT normalize_search(name_ar), id FROM vehicles
     WHERE archived_at IS NULL AND level <> 'type' AND name_ar IS NOT NULL
       AND normalize_search(name_ar) = ANY(${keys}::text[])`.execute(trx);
  const byKey = new Map<string, string[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.id]);

  const consumed = new Set<number>();
  const vehicleIds = new Set<string>();
  for (const [key, positions] of grams) {
    const ids = byKey.get(key);
    if (ids === undefined || positions.some((p) => consumed.has(p))) continue;
    positions.forEach((p) => consumed.add(p));
    ids.forEach((id) => vehicleIds.add(id));
  }
  return { vehicleIds: [...vehicleIds], rest: words.filter((_, i) => !consumed.has(i)) };
}

/**
 * Vehicles a part may be fitted to and still match: the named nodes, their ancestors
 * (a part fitted to the whole model fits each generation) and their descendants (a
 * generation of the named model), descendants filtered by year when one was given.
 */
async function vehicleClosure(trx: Trx, ids: string[], year: number | null): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    WITH RECURSIVE
      base AS (SELECT unnest(${ids}::uuid[]) AS id),
      up AS (
        SELECT id FROM base
        UNION
        SELECT v.parent_id FROM vehicles v JOIN up ON v.id = up.id WHERE v.parent_id IS NOT NULL
      ),
      down AS (
        SELECT id FROM base
        UNION
        SELECT v.id FROM vehicles v JOIN down ON v.parent_id = down.id
         WHERE v.archived_at IS NULL
           AND (${year}::int IS NULL OR v.level NOT IN ('generation', 'engine')
                OR ((v.year_from IS NULL OR v.year_from <= ${year}::int)
                    AND (v.year_to IS NULL OR v.year_to >= ${year}::int)))
      )
    SELECT id FROM up UNION SELECT id FROM down`.execute(trx);
  return rows.map((r) => r.id);
}

export async function searchCatalog(
  trx: Trx,
  input: SearchInput,
  functionalCurrency: string,
  now: Date,
): Promise<SearchResult> {
  const interpretation = interpret(input.q);
  const detected = await detectVehicles(trx, interpretation.text);
  const namedVehicles = [
    ...detected.vehicleIds,
    ...(input.vehicleId === undefined ? [] : [input.vehicleId]),
  ];
  const closure =
    namedVehicles.length === 0 ? [] : await vehicleClosure(trx, namedVehicles, interpretation.year);

  // 1. Part number / SKU matches (exact before prefix).
  const numberHits = new Map<string, number>();
  if (interpretation.partNumbers.length > 0) {
    const cands = interpretation.partNumbers;
    const nums = await trx
      .selectFrom('part_numbers')
      .select(['part_id', 'number_norm'])
      .where('removed_at', 'is', null)
      .where((eb) => eb.or(cands.map((c) => eb('number_norm', 'like', likePrefix(c)))))
      .limit(200)
      .execute();
    const skus = await trx
      .selectFrom('parts')
      .select(['id as part_id', 'sku_norm as number_norm'])
      .where('archived_at', 'is', null)
      .where((eb) => eb.or(cands.map((c) => eb('sku_norm', 'like', likePrefix(c)))))
      .limit(50)
      .execute();
    for (const r of [...nums, ...skus]) {
      const strength = r.number_norm !== null && cands.includes(r.number_norm) ? 2 : 1;
      numberHits.set(r.part_id, Math.max(numberHits.get(r.part_id) ?? 0, strength));
    }
  }

  // 2. Words (all must match the part's search text), optionally restricted to vehicles.
  const words = detected.rest.filter(
    (w) => !(interpretation.partNumbers.includes(normalizePartNumber(w)) && numberHits.size > 0),
  );
  let textHits: { id: string; score: number }[] = [];
  if (words.length > 0 || closure.length > 0) {
    const phrase = words.join(' ');
    let q = trx
      .selectFrom('parts as p')
      .select(['p.id', sql<number>`word_similarity(${phrase}, p.search_text)`.as('score')])
      .where('p.archived_at', 'is', null);
    for (const w of words) q = q.where('p.search_text', 'like', likeContains(w));
    if (closure.length > 0) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('fitments as f')
            .select(sql`1`.as('one'))
            .whereRef('f.part_id', '=', 'p.id')
            .where('f.removed_at', 'is', null)
            .where('f.vehicle_id', 'in', closure),
        ),
      );
    }
    textHits = await q
      .orderBy('score', 'desc')
      .orderBy('p.sku')
      .limit(input.limit * 2)
      .execute();
  }

  const ordered = [
    ...[...numberHits.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    ...textHits.map((h) => h.id),
  ];
  const resultIds = [...new Set(ordered)].slice(0, input.limit);

  // 3. Alternatives: replacement (supersession) > interchange group > shared OEM number.
  const altRows =
    resultIds.length === 0
      ? []
      : (
          await sql<{
            base: string;
            alt: string;
            relation: 'interchange' | 'shared_number' | 'replacement';
          }>`
            SELECT s.old_part_id AS base, s.new_part_id AS alt, 'replacement' AS relation
              FROM supersessions s
             WHERE s.removed_at IS NULL AND s.old_part_id = ANY(${resultIds}::uuid[])
            UNION
            SELECT m1.part_id, m2.part_id, 'interchange'
              FROM interchange_members m1
              JOIN interchange_members m2
                ON m2.tenant_id = m1.tenant_id AND m2.group_id = m1.group_id
               AND m2.part_id <> m1.part_id AND m2.removed_at IS NULL
             WHERE m1.removed_at IS NULL AND m1.part_id = ANY(${resultIds}::uuid[])
            UNION
            SELECT n1.part_id, n2.part_id, 'shared_number'
              FROM part_numbers n1
              JOIN part_numbers n2
                ON n2.tenant_id = n1.tenant_id AND n2.number_norm = n1.number_norm
               AND n2.part_id <> n1.part_id AND n2.removed_at IS NULL AND n2.kind = 'oem'
             WHERE n1.removed_at IS NULL AND n1.kind = 'oem' AND n1.part_id = ANY(${resultIds}::uuid[])`.execute(
            trx,
          )
        ).rows;
  const relationRank = { replacement: 0, interchange: 1, shared_number: 2 } as const;
  const alternatives = new Map<string, Map<string, keyof typeof relationRank>>();
  for (const r of altRows) {
    const forBase = alternatives.get(r.base) ?? new Map<string, keyof typeof relationRank>();
    const existing = forBase.get(r.alt);
    if (existing === undefined || relationRank[r.relation] < relationRank[existing]) {
      forBase.set(r.alt, r.relation);
    }
    alternatives.set(r.base, forBase);
  }

  const allIds = [
    ...new Set([...resultIds, ...[...alternatives.values()].flatMap((m) => [...m.keys()])]),
  ];
  const parts =
    allIds.length === 0
      ? []
      : await trx.selectFrom('parts').select(PART_COLUMNS).where('id', 'in', allIds).execute();
  const partById = new Map(parts.map((p) => [p.id, p]));

  const currency = input.currency ?? functionalCurrency;
  const list = await defaultPriceList(trx, currency);
  const prices =
    list === undefined ? new Map<string, string>() : await currentPrices(trx, list.id, allIds, now);
  /** Archived parts are never offered, as a result or as an alternative. */
  const hit = (id: string) => {
    const row = partById.get(id);
    if (row?.archived_at !== null) return null;
    const amount = prices.get(id);
    return { part: toPartSummary(row), price: amount === undefined ? null : { amount, currency } };
  };
  // Best quality first, then cheapest, then SKU (scenario 1).
  const byQualityThenPrice = (
    a: { part: { qualityGrade: string | null; sku: string }; price: { amount: string } | null },
    b: { part: { qualityGrade: string | null; sku: string }; price: { amount: string } | null },
  ) =>
    gradeRank(a.part.qualityGrade) - gradeRank(b.part.qualityGrade) ||
    (a.price === null ? 1 : 0) - (b.price === null ? 1 : 0) ||
    (a.price !== null && b.price !== null
      ? dec(a.price.amount).comparedTo(dec(b.price.amount))
      : 0) ||
    a.part.sku.localeCompare(b.part.sku);

  const vehicles =
    namedVehicles.length === 0
      ? []
      : await trx
          .selectFrom('vehicles')
          .select(['id', 'name', 'level'])
          .where('id', 'in', namedVehicles)
          .execute();

  return {
    interpretation: {
      text: words,
      year: interpretation.year,
      partNumber: numberHits.size > 0 ? (interpretation.partNumbers[0] ?? null) : null,
      vehicles: vehicles.map((v) => ({ id: v.id, name: v.name, level: v.level as 'model' })),
    },
    results: resultIds.flatMap((id) => {
      const base = hit(id);
      if (base === null) return [];
      const alts = [...(alternatives.get(id)?.entries() ?? [])]
        .map(([altId, relation]) => {
          const h = hit(altId);
          return h === null ? null : { ...h, relation };
        })
        .filter((a) => a !== null)
        .sort(byQualityThenPrice);
      return [
        {
          ...base,
          matchedBy: numberHits.has(id)
            ? ('number' as const)
            : words.length > 0
              ? ('text' as const)
              : ('vehicle' as const),
          alternatives: alts,
        },
      ];
    }),
  };
}
