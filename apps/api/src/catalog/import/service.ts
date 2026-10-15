import {
  IMPORT_MAX_ROWS,
  importMappingSchema,
  newId,
  tenantSettingsSchema,
} from '@autoparts/shared';
import type {
  ImportBatch,
  ImportBatchDetail,
  ImportCell,
  ImportDecision,
  ImportIssue,
  ImportMapping,
  ImportStats,
  ParsedImportRow,
} from '@autoparts/shared';
import { sql } from 'kysely';
import { ApiError, notFound } from '../../errors';
import type { Trx } from '../mappers';
import { currentPrices, iso } from '../mappers';
import type { AnalysedRow, PriceSpec, RawImportRow } from './parse';
import { analyseRows, extractRaw, parseRow } from './parse';

const CHUNK = 500;

async function inChunks<T>(items: readonly T[], fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += CHUNK) await fn(items.slice(i, i + CHUNK));
}

const notEditable = () => new ApiError(409, 'import.not_editable');

/** Price list currency precision and the tenant rounding mode, for selling prices. */
async function priceSpec(trx: Trx, mapping: ImportMapping): Promise<PriceSpec | null> {
  if (mapping.priceListId == null) return null;
  const list = await trx
    .selectFrom('price_lists as l')
    .innerJoin('tenant_currencies as c', (j) =>
      j.onRef('c.tenant_id', '=', 'l.tenant_id').onRef('c.code', '=', 'l.currency'),
    )
    .select(['c.minor_units'])
    .where('l.id', '=', mapping.priceListId)
    .where('l.archived_at', 'is', null)
    .executeTakeFirst();
  if (list === undefined) throw notFound();
  const tenant = await trx.selectFrom('tenants').select('settings').executeTakeFirstOrThrow();
  const settings = tenantSettingsSchema.safeParse(tenant.settings);
  // Rounding is a tenant decision made at provisioning; without it nothing is rounded.
  if (!settings.success) throw new ApiError(400, 'request.invalid');
  return { minorUnits: list.minor_units, roundingMode: settings.data.money.roundingMode };
}

async function assertCostCurrency(trx: Trx, mapping: ImportMapping): Promise<void> {
  if (mapping.costCurrency == null) return;
  const found = await trx
    .selectFrom('tenant_currencies')
    .select('id')
    .where('code', '=', mapping.costCurrency)
    .executeTakeFirst();
  if (found === undefined) throw new ApiError(400, 'request.invalid');
}

async function assertNotApplied(trx: Trx, sha256: Buffer, sheet: string): Promise<void> {
  const applied = await trx
    .selectFrom('import_batches')
    .select('id')
    .where('file_sha256', '=', sha256)
    .where('sheet_name', '=', sheet)
    .where('status', '=', 'applied')
    .executeTakeFirst();
  if (applied !== undefined) throw new ApiError(409, 'import.already_applied');
}

export interface StageInput {
  id: string;
  fileName: string;
  sha256: Buffer;
  sheet: string;
  headerRow: number;
  mapping: ImportMapping;
}

/** Stores the mapped columns of the data rows (below the header row) and analyses them. */
export async function stageBatch(
  trx: Trx,
  actor: { tenantId: string; userId: string },
  input: StageInput,
  rows: readonly ImportCell[][],
): Promise<void> {
  await assertNotApplied(trx, input.sha256, input.sheet);
  await assertCostCurrency(trx, input.mapping);
  await priceSpec(trx, input.mapping);

  const data = rows
    .map((cells, i) => ({ rowNumber: i + 1, raw: extractRaw(cells, input.mapping) }))
    .slice(input.headerRow)
    // Rows with nothing in the mapped columns are not data (and are not stored).
    .filter((r) => Object.values(r.raw).some((v) => v !== null));
  if (data.length > IMPORT_MAX_ROWS) throw new ApiError(400, 'import.too_many_rows');

  await trx
    .insertInto('import_batches')
    .values({
      id: input.id,
      tenant_id: actor.tenantId,
      kind: 'catalog',
      file_name: input.fileName,
      file_sha256: input.sha256,
      sheet_name: input.sheet,
      header_row: input.headerRow,
      mapping: JSON.stringify(input.mapping),
      created_by: actor.userId,
    })
    .execute();
  await inChunks(data, (chunk) =>
    trx
      .insertInto('import_rows')
      .values(
        chunk.map((r) => ({
          id: newId(),
          tenant_id: actor.tenantId,
          batch_id: input.id,
          row_number: r.rowNumber,
          raw: JSON.stringify(r.raw),
        })),
      )
      .execute(),
  );
  await analyseBatch(trx, input.id);
}

interface BatchRow {
  id: string;
  status: string;
  mapping: ImportMapping;
}

async function loadBatchRow(trx: Trx, id: string, lock = false): Promise<BatchRow> {
  let q = trx.selectFrom('import_batches').select(['id', 'status', 'mapping']).where('id', '=', id);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound();
  return { id: row.id, status: row.status, mapping: importMappingSchema.parse(row.mapping) };
}

export interface Analysed extends AnalysedRow {
  id: string;
  rowNumber: number;
  parsed: ParsedImportRow;
  rowKey: string | null;
}

function statsOf(rows: readonly Analysed[]): ImportStats {
  const byDecision: Partial<Record<ImportDecision, number>> = {};
  const byIssue: Partial<Record<ImportIssue, number>> = {};
  for (const r of rows) {
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    for (const i of r.issues) byIssue[i] = (byIssue[i] ?? 0) + 1;
  }
  return { rows: rows.length, byDecision, byIssue };
}

/**
 * Re-reads the stored cells with the current mapping, aliases and earlier imports, and
 * stores what applying would do. Runs at staging, on request (after mapping vehicle codes)
 * and again inside apply.
 */
export async function analyseBatch(trx: Trx, batchId: string, lock = false) {
  const batch = await loadBatchRow(trx, batchId, lock);
  if (batch.status === 'applied' || batch.status === 'discarded') throw notEditable();
  const spec = await priceSpec(trx, batch.mapping);
  const stored = await trx
    .selectFrom('import_rows')
    .select(['id', 'row_number', 'raw', 'skipped_by_user'])
    .where('batch_id', '=', batchId)
    .orderBy('row_number')
    .execute();
  const inputs = stored.map((r) => {
    const parsed = parseRow(r.raw as RawImportRow, spec);
    // With an SKU column but no prefix, a row without an SKU cannot get one.
    if (parsed.parsed.sku === undefined && batch.mapping.skuPrefix == null) {
      parsed.issues.push('bad_sku');
    }
    return { id: r.id, rowNumber: r.row_number, skippedByUser: r.skipped_by_user, ...parsed };
  });

  const keys = [...new Set(inputs.flatMap((r) => (r.rowKey === null ? [] : [r.rowKey])))];
  const codes = [...new Set(inputs.flatMap((r) => r.parsed.vehicleCodeNorm ?? []))];
  const skus = [...new Set(inputs.flatMap((r) => r.parsed.sku?.toUpperCase() ?? []))];
  const prior =
    keys.length === 0
      ? []
      : (
          await sql<{ row_key: string; part_id: string }>`
            SELECT DISTINCT ON (r.row_key) r.row_key, r.part_id
              FROM import_rows r
              JOIN import_batches b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id
              JOIN parts p ON p.tenant_id = r.tenant_id AND p.id = r.part_id
             WHERE b.status = 'applied' AND r.part_id IS NOT NULL AND p.archived_at IS NULL
               AND r.row_key = ANY(${keys}::text[])
             ORDER BY r.row_key, b.applied_at DESC`.execute(trx)
        ).rows;
  const mapped =
    codes.length === 0
      ? []
      : await trx
          .selectFrom('vehicle_aliases')
          .select('alias_norm')
          .where('removed_at', 'is', null)
          .where('alias_norm', 'in', codes)
          .execute();
  const existing =
    skus.length === 0
      ? []
      : (
          await sql<{ sku: string }>`
            SELECT upper(sku) AS sku FROM parts WHERE upper(sku) = ANY(${skus}::text[])`.execute(
            trx,
          )
        ).rows;

  const decided = analyseRows(inputs, {
    priorParts: new Map(prior.map((p) => [p.row_key, p.part_id])),
    mappedCodes: new Set(mapped.flatMap((m) => m.alias_norm ?? [])),
    existingSkus: new Set(existing.map((s) => s.sku)),
  });
  const analysed: Analysed[] = inputs.map((r, i) => ({
    id: r.id,
    rowNumber: r.rowNumber,
    parsed: r.parsed,
    rowKey: r.rowKey,
    ...(decided[i] ?? { decision: 'skip', issues: r.issues, partId: null }),
  }));

  await inChunks(analysed, (chunk) =>
    sql`
      UPDATE import_rows r
         SET parsed = v.parsed, issues = v.issues, decision = v.decision, row_key = v.row_key,
             part_id = v.part_id
        FROM jsonb_to_recordset(${JSON.stringify(
          chunk.map((a) => ({
            id: a.id,
            parsed: a.parsed,
            issues: a.issues,
            decision: a.decision,
            row_key: a.rowKey,
            part_id: a.partId,
          })),
        )}::jsonb) AS v(id uuid, parsed jsonb, issues text[], decision text, row_key text, part_id uuid)
       WHERE r.id = v.id`.execute(trx),
  );
  const stats = statsOf(analysed);
  await trx
    .updateTable('import_batches')
    .set({ stats: JSON.stringify(stats) })
    .where('id', '=', batchId)
    .execute();
  return { batch, analysed, stats, spec };
}

interface AliasTargets {
  vehicleIds: string[];
  categoryId: string | null;
}

async function aliasTargets(trx: Trx, codes: readonly string[]) {
  const map = new Map<string, AliasTargets>();
  if (codes.length === 0) return map;
  const rows = await trx
    .selectFrom('vehicle_aliases')
    .select(['alias_norm', 'target', 'vehicle_id', 'category_id'])
    .where('removed_at', 'is', null)
    .where('alias_norm', 'in', codes)
    .orderBy('created_at')
    .execute();
  for (const r of rows) {
    if (r.alias_norm === null) continue;
    const t = map.get(r.alias_norm) ?? { vehicleIds: [], categoryId: null };
    if (r.target === 'vehicle' && r.vehicle_id !== null) t.vehicleIds.push(r.vehicle_id);
    if (r.target === 'category' && t.categoryId === null) t.categoryId = r.category_id;
    map.set(r.alias_norm, t);
  }
  return map;
}

async function nextSkuNumber(trx: Trx, prefix: string): Promise<number> {
  const { rows } = await sql<{ max: number | null }>`
    SELECT max((regexp_match(upper(sku), ${`^${prefix}-(\\d+)$`}))[1]::bigint)::int AS max
      FROM parts`.execute(trx);
  return (rows[0]?.max ?? 0) + 1;
}

/**
 * Applies a staged import in the caller's transaction: creates parts, numbers, fitments and
 * prices, refreshes prices of parts from earlier imports, and links each row to its part.
 * The same sheet of the same file can be applied once (unique index + check).
 */
export async function applyBatch(
  trx: Trx,
  actor: { tenantId: string; userId: string },
  batchId: string,
  now: Date,
): Promise<ImportStats> {
  const { batch, analysed, stats, spec } = await analyseBatch(trx, batchId, true);
  const meta = await trx
    .selectFrom('import_batches')
    .select(['file_sha256', 'sheet_name'])
    .where('id', '=', batchId)
    .executeTakeFirstOrThrow();
  await assertNotApplied(trx, meta.file_sha256, meta.sheet_name ?? '');
  const mapping = batch.mapping;
  const targets = await aliasTargets(trx, [
    ...new Set(analysed.flatMap((a) => a.parsed.vehicleCodeNorm ?? [])),
  ]);

  let seq = 0;
  if (mapping.skuPrefix != null) {
    // Continue after the highest PREFIX-n in the tenant or in this file's SKU column.
    const pattern = new RegExp(`^${mapping.skuPrefix}-(\\d+)$`);
    const inFile = analysed.map((a) =>
      Number(pattern.exec(a.parsed.sku?.toUpperCase() ?? '')?.[1] ?? 0),
    );
    seq = Math.max(await nextSkuNumber(trx, mapping.skuPrefix), Math.max(0, ...inFile) + 1);
  }
  const partByKey = new Map<string, string>();
  const parts: {
    id: string;
    tenant_id: string;
    sku: string;
    name_ar: string | null;
    name_en: string | null;
    category_id: string | null;
  }[] = [];
  const numbers: {
    id: string;
    tenant_id: string;
    part_id: string;
    number: string;
    kind: string;
  }[] = [];
  const fitments = new Map<string, { part_id: string; vehicle_id: string }>();
  const pricesFor: { partId: string; price: string; update: boolean }[] = [];
  const links: { id: string; part_id: string }[] = [];

  const addFitments = (partId: string, code: string | undefined) => {
    for (const vehicleId of (code === undefined ? undefined : targets.get(code))?.vehicleIds ??
      []) {
      fitments.set(`${partId}|${vehicleId}`, { part_id: partId, vehicle_id: vehicleId });
    }
  };

  for (const a of analysed) {
    if (a.decision === 'skip' || a.rowKey === null) continue;
    if (a.decision === 'create') {
      const id = newId();
      partByKey.set(a.rowKey, id);
      const code = a.parsed.vehicleCodeNorm;
      parts.push({
        id,
        tenant_id: actor.tenantId,
        sku: a.parsed.sku ?? `${mapping.skuPrefix ?? ''}-${String(seq++).padStart(5, '0')}`,
        name_ar: a.parsed.nameAr ?? null,
        name_en: a.parsed.nameEn ?? null,
        category_id: (code === undefined ? undefined : targets.get(code))?.categoryId ?? null,
      });
      if (a.parsed.partNumber !== undefined) {
        numbers.push({
          id: newId(),
          tenant_id: actor.tenantId,
          part_id: id,
          number: a.parsed.partNumber,
          kind: mapping.numberKind,
        });
      }
      addFitments(id, code);
      if (a.parsed.sellPrice !== undefined) {
        pricesFor.push({ partId: id, price: a.parsed.sellPrice, update: false });
      }
      links.push({ id: a.id, part_id: id });
    } else if (a.decision === 'merge') {
      const id = partByKey.get(a.rowKey);
      if (id !== undefined) links.push({ id: a.id, part_id: id });
    } else if (a.partId !== null) {
      partByKey.set(a.rowKey, a.partId);
      addFitments(a.partId, a.parsed.vehicleCodeNorm);
      if (a.parsed.sellPrice !== undefined) {
        pricesFor.push({ partId: a.partId, price: a.parsed.sellPrice, update: true });
      }
      links.push({ id: a.id, part_id: a.partId });
    }
  }

  await inChunks(parts, (chunk) => trx.insertInto('parts').values(chunk).execute());
  await inChunks(numbers, (chunk) => trx.insertInto('part_numbers').values(chunk).execute());

  // Fitments: only the ones a part does not have yet (updates may already have them).
  const wanted = [...fitments.values()];
  const have = new Set<string>();
  const updatedParts = [...new Set(wanted.map((f) => f.part_id))];
  await inChunks(updatedParts, async (chunk) => {
    const rows = await trx
      .selectFrom('fitments')
      .select(['part_id', 'vehicle_id'])
      .where('removed_at', 'is', null)
      .where('part_id', 'in', chunk)
      .execute();
    rows.forEach((f) => have.add(`${f.part_id}|${f.vehicle_id}`));
  });
  const newFitments = wanted
    .filter((f) => !have.has(`${f.part_id}|${f.vehicle_id}`))
    .map((f) => ({ id: newId(), tenant_id: actor.tenantId, ...f }));
  await inChunks(newFitments, (chunk) => trx.insertInto('fitments').values(chunk).execute());

  // Prices: new parts always; parts from earlier imports only when the price changed.
  let priceRows: { partId: string; price: string }[] = [];
  if (mapping.priceListId != null && spec !== null) {
    const listId = mapping.priceListId;
    const updates = pricesFor.filter((p) => p.update).map((p) => p.partId);
    const current = await currentPrices(trx, listId, updates, now);
    priceRows = pricesFor.filter((p) => !p.update || current.get(p.partId) !== p.price);
    await inChunks(priceRows, (chunk) =>
      trx
        .insertInto('part_prices')
        .values(
          chunk.map((p) => ({
            id: newId(),
            tenant_id: actor.tenantId,
            price_list_id: listId,
            part_id: p.partId,
            price: p.price,
            effective_at: now,
            recorded_by: actor.userId,
            source: 'import',
            import_batch_id: batchId,
          })),
        )
        .execute(),
    );
  }

  await inChunks(links, (chunk) =>
    sql`
      UPDATE import_rows r SET part_id = v.part_id
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(id uuid, part_id uuid)
       WHERE r.id = v.id`.execute(trx),
  );

  const result: ImportStats = {
    ...stats,
    pricesSet: priceRows.length,
    fitmentsAdded: newFitments.length,
  };
  await trx
    .updateTable('import_batches')
    .set({
      status: 'applied',
      applied_at: now,
      applied_by: actor.userId,
      stats: JSON.stringify(result),
    })
    .where('id', '=', batchId)
    .execute();
  return result;
}

const batchColumns = [
  'id',
  'file_name',
  'sheet_name',
  'header_row',
  'status',
  'mapping',
  'stats',
  'created_at',
  'applied_at',
] as const;

function toBatch(row: {
  id: string;
  file_name: string;
  sheet_name: string | null;
  header_row: number | null;
  status: string;
  mapping: unknown;
  stats: unknown;
  created_at: Date;
  applied_at: Date | null;
}): ImportBatch {
  const mapping = importMappingSchema.safeParse(row.mapping);
  return {
    id: row.id,
    fileName: row.file_name,
    sheet: row.sheet_name,
    headerRow: row.header_row,
    status: row.status as ImportBatch['status'],
    mapping: mapping.success ? mapping.data : null,
    stats: row.stats as ImportStats,
    createdAt: row.created_at.toISOString(),
    appliedAt: iso(row.applied_at),
  };
}

export async function listBatches(trx: Trx): Promise<ImportBatch[]> {
  const rows = await trx
    .selectFrom('import_batches')
    .select(batchColumns)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  return rows.map(toBatch);
}

/** The batch with its vehicle codes and how each is mapped today. */
export async function loadBatchDetail(trx: Trx, id: string): Promise<ImportBatchDetail> {
  const row = await trx
    .selectFrom('import_batches')
    .select(batchColumns)
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw notFound();
  const { rows: codes } = await sql<{ code: string; code_norm: string; rows: number }>`
    SELECT min(parsed->>'vehicleCode') AS code, parsed->>'vehicleCodeNorm' AS code_norm,
           count(*)::int AS rows
      FROM import_rows
     WHERE batch_id = ${id} AND parsed ? 'vehicleCodeNorm'
     GROUP BY parsed->>'vehicleCodeNorm'
     ORDER BY count(*) DESC, 2`.execute(trx);
  const aliases = await trx
    .selectFrom('vehicle_aliases as a')
    .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .select(['a.alias_norm', 'a.target', 'a.vehicle_id', 'a.category_id', 'v.name as vehicle_name'])
    .where('a.removed_at', 'is', null)
    .where('a.alias_norm', 'in', codes.length === 0 ? [''] : codes.map((c) => c.code_norm))
    .execute();
  return {
    ...toBatch(row),
    vehicleCodes: codes.map((c) => {
      const own = aliases.filter((a) => a.alias_norm === c.code_norm);
      const first = own[0];
      return {
        code: c.code,
        codeNorm: c.code_norm,
        rows: c.rows,
        mapping:
          first === undefined
            ? null
            : {
                target: own.some((a) => a.target === 'vehicle')
                  ? 'vehicle'
                  : (first.target as 'category' | 'ignore'),
                vehicles: own.flatMap((a) =>
                  a.vehicle_id === null ? [] : [{ id: a.vehicle_id, name: a.vehicle_name ?? '' }],
                ),
                categoryId: own.find((a) => a.category_id !== null)?.category_id ?? null,
              },
      };
    }),
  };
}

export async function skipRows(trx: Trx, batchId: string, rowIds: string[], skipped: boolean) {
  const batch = await loadBatchRow(trx, batchId, true);
  if (batch.status === 'applied' || batch.status === 'discarded') throw notEditable();
  await trx
    .updateTable('import_rows')
    .set({ skipped_by_user: skipped })
    .where('batch_id', '=', batchId)
    .where('id', 'in', rowIds)
    .execute();
  await analyseBatch(trx, batchId);
}

export async function discardBatch(trx: Trx, batchId: string) {
  const batch = await loadBatchRow(trx, batchId, true);
  if (batch.status === 'applied' || batch.status === 'discarded') throw notEditable();
  await trx
    .updateTable('import_batches')
    .set({ status: 'discarded' })
    .where('id', '=', batchId)
    .execute();
}

export async function markPreviewed(trx: Trx, batchId: string) {
  await trx
    .updateTable('import_batches')
    .set({ status: 'previewed' })
    .where('id', '=', batchId)
    .where('status', '=', 'draft')
    .execute();
}
