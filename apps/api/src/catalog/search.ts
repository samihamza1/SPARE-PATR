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
/** Adjacent number tokens joined into one candidate, at most ("04465 60320" is one number). */
const MAX_JOIN = 4;
const MAX_CANDIDATES = 12;
/**
 * Separators between search tokens, as normalize_search() treats them, except the
 * characters a part number is written with ('-', '.', '/', '_', '\'): those stay inside a
 * token so "04465-60320" is one number.
 */
const NUMBER_TOKEN_SEPARATORS = /[\s,;:(){}[\]"'*+#&|!?\u060c\u061b\u00a0\u2007\u202f]+/;

export interface NumberCandidate {
  /** Normalised like part_numbers.number_norm. */
  value: string;
  /** Matched only exactly (a year-like token); otherwise exactly or as a prefix. */
  exactOnly: boolean;
  /** Which run of adjacent number tokens it comes from, and how many tokens it joins. */
  run: number;
  span: number;
  /** The query's words it stands for (normalised like the search text). */
  words: string[];
}

export interface Interpretation {
  /** The query's words, normalised; vehicles and years are recognised among them later. */
  words: string[];
  numbers: NumberCandidate[];
}

/**
 * Splits the query into words and part-number candidates (ADR 0015 addendum).
 *
 * A number is one whitespace-separated token with digits ("04465-60320"), or a run of
 * adjacent ones ("04465 60320"); every contiguous join of a run is a candidate, longest
 * first. Words without digits never join a number, so "pads 04465 60320" still finds
 * 0446560320. A year-like token (19xx/20xx) breaks a run and is matched only exactly,
 * unless it is the whole query (a numeric SKU such as "2015").
 */
export function interpret(q: string): Interpretation {
  const words = normalizeSearchText(q)
    .split(' ')
    .filter((t) => t !== '');
  const raw = q.split(NUMBER_TOKEN_SEPARATORS).filter((t) => t !== '');
  const tokens = raw.map((t) => ({
    norm: normalizePartNumber(t),
    words: normalizeSearchText(t)
      .split(' ')
      .filter((w) => w !== ''),
  }));
  const isNumber = (t: { norm: string }) => /\d/.test(t.norm);
  const isYear = (t: { norm: string }) => YEAR.test(t.norm) && tokens.length > 1;
  const inRun = (k: number) => {
    const t = tokens[k];
    return t !== undefined && isNumber(t) && !isYear(t);
  };

  const numbers: NumberCandidate[] = [];
  const add = (c: NumberCandidate) => {
    if (c.value.length >= 4 && !numbers.some((n) => n.value === c.value)) numbers.push(c);
  };
  let run = 0;
  for (let i = 0; i < tokens.length;) {
    const first = tokens[i];
    if (first === undefined || !isNumber(first) || isYear(first)) {
      if (first !== undefined && isYear(first)) {
        add({ value: first.norm, exactOnly: true, run: -1, span: 1, words: first.words });
      }
      i++;
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && inRun(j)) j++;
    for (let span = Math.min(MAX_JOIN, j - i); span >= 1; span--) {
      for (let k = i; k + span <= j; k++) {
        const part = tokens.slice(k, k + span);
        add({
          value: part.map((t) => t.norm).join(''),
          exactOnly: false,
          run,
          span,
          words: part.flatMap((t) => t.words),
        });
      }
    }
    run++;
    i = j;
  }
  return { words, numbers: numbers.slice(0, MAX_CANDIDATES) };
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
 * Keeps the most specific of the named vehicles: a make named together with one of its
 * models ("toyota land cruiser") must not widen the search to the whole make.
 */
async function mostSpecific(trx: Trx, ids: string[]): Promise<string[]> {
  if (ids.length < 2) return ids;
  const { rows } = await sql<{ id: string }>`
    WITH RECURSIVE up AS (
      SELECT parent_id AS id FROM vehicles WHERE id = ANY(${ids}::uuid[])
      UNION
      SELECT v.parent_id FROM vehicles v JOIN up ON v.id = up.id
    )
    SELECT id FROM up WHERE id IS NOT NULL`.execute(trx);
  const ancestors = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !ancestors.has(id));
}

interface Years {
  from: number;
  to: number;
}

/**
 * Vehicles a part may be fitted to and still match: the named nodes, their ancestors
 * (a part fitted to the whole model fits each generation) and their descendants (a
 * generation of the named model), descendants filtered by the years when given.
 */
async function vehicleClosure(trx: Trx, ids: string[], years: Years | null): Promise<string[]> {
  const from = years?.from ?? null;
  const to = years?.to ?? null;
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
           AND (${from}::int IS NULL OR v.level NOT IN ('generation', 'engine')
                OR ((v.year_from IS NULL OR v.year_from <= ${to}::int)
                    AND (v.year_to IS NULL OR v.year_to >= ${from}::int)))
      )
    SELECT id FROM up UNION SELECT id FROM down`.execute(trx);
  return rows.map((r) => r.id);
}

interface NumberRow {
  part_id: string;
  norm: string;
  archived: boolean;
}

/**
 * Parts whose number or SKU matches a candidate, exact matches first. Within each run of
 * number tokens only the longest join that matched anything counts: "04465 60320" finds
 * 0446560320 and not every number that merely starts with 04465.
 */
async function numberMatches(trx: Trx, numbers: NumberCandidate[]) {
  const prefixes = numbers.filter((n) => !n.exactOnly).map((n) => likePrefix(n.value));
  const values = numbers.map((n) => n.value);
  // OR-ed prefix LIKEs (not LIKE ANY), so each can use the text_pattern_ops index.
  const matching = (column: string) =>
    sql.join(
      [
        ...prefixes.map((p) => sql`${sql.ref(column)} LIKE ${p}`),
        sql`${sql.ref(column)} = ANY(${values}::text[])`,
      ],
      sql` OR `,
    );
  const order = (column: string) =>
    sql`(${sql.ref(column)} = ANY(${values}::text[])) DESC, length(${sql.ref(column)}), ${sql.ref(column)}`;
  // Archived parts are read too: their replacement is offered instead (BRIEF scenario 7).
  const { rows: byNumber } = await sql<NumberRow>`
    SELECT n.part_id, n.number_norm AS norm, p.archived_at IS NOT NULL AS archived
      FROM part_numbers n JOIN parts p ON p.tenant_id = n.tenant_id AND p.id = n.part_id
     WHERE n.removed_at IS NULL AND (${matching('n.number_norm')})
     ORDER BY ${order('n.number_norm')}
     LIMIT 200`.execute(trx);
  const { rows: bySku } = await sql<NumberRow>`
    SELECT p.id AS part_id, p.sku_norm AS norm, p.archived_at IS NOT NULL AS archived
      FROM parts p
     WHERE (${matching('p.sku_norm')})
     ORDER BY ${order('p.sku_norm')}
     LIMIT 50`.execute(trx);

  const matches = (n: NumberCandidate, norm: string) =>
    norm === n.value || (!n.exactOnly && norm.startsWith(n.value));
  // The longest join that matched, per run.
  const best = new Map<number, number>();
  for (const row of [...byNumber, ...bySku]) {
    for (const n of numbers) {
      if (matches(n, row.norm)) best.set(n.run, Math.max(best.get(n.run) ?? 0, n.span));
    }
  }
  const counted = numbers.filter((n) => best.get(n.run) === n.span);
  const hits = new Map<string, { strength: number; archived: boolean }>();
  let reported: { value: string; strength: number; span: number } | null = null;
  for (const row of [...byNumber, ...bySku]) {
    for (const n of counted) {
      if (!matches(n, row.norm)) continue;
      const strength = row.norm === n.value ? 2 : 1;
      const prev = hits.get(row.part_id);
      if (prev === undefined || strength > prev.strength) {
        hits.set(row.part_id, { strength, archived: row.archived });
      }
      if (
        reported === null ||
        strength > reported.strength ||
        (strength === reported.strength && n.span > reported.span)
      ) {
        reported = { value: n.value, strength, span: n.span };
      }
    }
  }
  return { hits, counted, reported: reported?.value ?? null };
}

/**
 * The part that replaces each given part today: follow active supersessions to the last
 * part of the chain that is not archived (A -> B archived -> C offers C).
 */
async function currentReplacements(trx: Trx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ base: string; part: string }>`
    WITH RECURSIVE chain AS (
      SELECT s.old_part_id AS base, s.new_part_id AS part, 1 AS depth
        FROM supersessions s
       WHERE s.removed_at IS NULL AND s.old_part_id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT c.base, s.new_part_id, c.depth + 1
        FROM chain c JOIN supersessions s ON s.old_part_id = c.part AND s.removed_at IS NULL
       WHERE c.depth < 50
    )
    SELECT DISTINCT ON (c.base) c.base, c.part
      FROM chain c JOIN parts p ON p.id = c.part
     WHERE p.archived_at IS NULL
     ORDER BY c.base, c.depth DESC`.execute(trx);
  return new Map(rows.map((r) => [r.base, r.part]));
}

interface AlternativeRow {
  base: string;
  alt: string;
  relation: 'interchange' | 'shared_number' | 'replacement';
}

export async function searchCatalog(
  trx: Trx,
  input: SearchInput,
  functionalCurrency: string,
  now: Date,
): Promise<SearchResult> {
  const interpretation = interpret(input.q);
  // Vehicles first, on every word: "peugeot 2008" names a model, not the year 2008.
  const detected = await detectVehicles(trx, interpretation.words);
  const yearWords = detected.rest.filter((w) => YEAR.test(w));
  const yearValues = yearWords.map((w) => Number.parseInt(w, 10));
  // "2008-2015" is a range; a single year is a range of one.
  const years =
    yearValues.length === 0 ? null : { from: Math.min(...yearValues), to: Math.max(...yearValues) };
  const textVehicles = await mostSpecific(trx, detected.vehicleIds);
  // A vehicle chosen in the UI restricts the typed one (and the other way round).
  let closure: string[] | null = null;
  if (textVehicles.length > 0) closure = await vehicleClosure(trx, textVehicles, years);
  if (input.vehicleId !== undefined) {
    const chosen = await vehicleClosure(trx, [input.vehicleId], years);
    closure = closure === null ? chosen : closure.filter((id) => chosen.includes(id));
  }
  const namedVehicles = [
    ...textVehicles,
    ...(input.vehicleId === undefined ? [] : [input.vehicleId]),
  ];

  // 1. Part number / SKU matches (exact before prefix).
  const numbers =
    interpretation.numbers.length === 0
      ? {
          hits: new Map<string, { strength: number; archived: boolean }>(),
          counted: [],
          reported: null,
        }
      : await numberMatches(trx, interpretation.numbers);
  const replacements = await currentReplacements(
    trx,
    [...numbers.hits.entries()].filter(([, h]) => h.archived).map(([id]) => id),
  );
  // An archived part found by its number leads to the part that replaces it.
  const numberHits = new Map<string, { strength: number; via: 'number' | 'replacement' }>();
  for (const [id, h] of numbers.hits) {
    const target = h.archived ? replacements.get(id) : id;
    if (target === undefined) continue;
    const via = h.archived ? ('replacement' as const) : ('number' as const);
    const prev = numberHits.get(target);
    if (
      prev === undefined ||
      h.strength > prev.strength ||
      (h.strength === prev.strength && via === 'number')
    ) {
      numberHits.set(target, { strength: h.strength, via });
    }
  }

  // 2. Words (all must match the part's search text), optionally restricted to vehicles.
  // Years and the words of the numbers that matched are not required words.
  const numberWords = new Set(numbers.counted.flatMap((n) => n.words));
  const words = detected.rest.filter((w) => !YEAR.test(w) && !numberWords.has(w));
  let textHits: { id: string; score: number }[] = [];
  // A closure with no vehicle left (a chosen vehicle and another one typed) matches nothing.
  const vehiclesPossible = closure === null || closure.length > 0;
  if (vehiclesPossible && (words.length > 0 || closure !== null)) {
    const phrase = words.join(' ');
    let q = trx
      .selectFrom('parts as p')
      .select(['p.id', sql<number>`word_similarity(${phrase}, p.search_text)`.as('score')])
      .where('p.archived_at', 'is', null);
    for (const w of words) q = q.where('p.search_text', 'like', likeContains(w));
    if (closure !== null) {
      const ids = closure;
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('fitments as f')
            .select(sql`1`.as('one'))
            .whereRef('f.part_id', '=', 'p.id')
            .where('f.removed_at', 'is', null)
            .where('f.vehicle_id', 'in', ids),
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
    ...[...numberHits.entries()]
      .sort(
        (a, b) =>
          b[1].strength - a[1].strength ||
          Number(a[1].via === 'replacement') - Number(b[1].via === 'replacement'),
      )
      .map(([id]) => id),
    ...textHits.map((h) => h.id),
  ];
  const resultIds = [...new Set(ordered)].slice(0, input.limit);

  // 3. Alternatives: replacement (supersession) > interchange group > shared OEM number.
  const altRows: AlternativeRow[] =
    resultIds.length === 0
      ? []
      : (
          await sql<{
            base: string;
            alt: string;
            relation: 'interchange' | 'shared_number' | 'replacement';
          }>`
            SELECT m1.part_id AS base, m2.part_id AS alt, 'interchange' AS relation
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
  // The replacement offered is the current end of the supersession chain.
  for (const [base, alt] of await currentReplacements(trx, resultIds)) {
    altRows.push({ base, alt, relation: 'replacement' });
  }
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
      year: years?.from ?? null,
      partNumber: numberHits.size > 0 ? numbers.reported : null,
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
          matchedBy:
            numberHits.get(id)?.via ??
            (words.length > 0 ? ('text' as const) : ('vehicle' as const)),
          alternatives: alts,
        },
      ];
    }),
  };
}
