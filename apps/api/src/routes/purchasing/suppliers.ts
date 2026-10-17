import {
  addSupplierPartSchema,
  createSupplierSchema,
  idParamsSchema,
  listSupplierPartsQuerySchema,
  listSuppliersQuerySchema,
  normalizePartNumber,
  resolveSupplierNumbersSchema,
  updateSupplierSchema,
  uuidSchema,
} from '@autoparts/shared';
import type {
  PartSummary,
  ResolvedSupplierNumber,
  Supplier,
  SupplierPart,
  SupplierPartPage,
} from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { PART_COLUMNS, toPartSummary } from '../../catalog/mappers';
import { currentReplacements } from '../../catalog/search';
import { ApiError, notFound } from '../../errors';
import { retryOnDuplicate } from '../../inventory/documents';
import type { Trx } from '../common';
import { actorOf, inTenant, iso } from '../common';

const VIEW = 'purchases.view' as const;
const MANAGE = 'purchases.manage' as const;
const MAX_CANDIDATES = 20;

const mappingParamsSchema = z.object({ id: uuidSchema, mappingId: uuidSchema });

async function loadSuppliers(
  trx: Trx,
  opts: { id?: string; q?: string | undefined; includeArchived?: boolean } = {},
): Promise<Supplier[]> {
  let q = trx
    .selectFrom('suppliers')
    .select(['id', 'name', 'default_currency', 'phone', 'note', 'archived_at'])
    .orderBy(sql`normalize_search(name)`)
    .orderBy('id');
  if (opts.id !== undefined) q = q.where('id', '=', opts.id);
  else if (opts.includeArchived !== true) q = q.where('archived_at', 'is', null);
  if (opts.q !== undefined && opts.q !== '') {
    q = q.where(sql<boolean>`strpos(normalize_search(name), normalize_search(${opts.q})) > 0`);
  }
  return (await q.execute()).map((s) => ({
    id: s.id,
    name: s.name,
    defaultCurrency: s.default_currency,
    phone: s.phone,
    note: s.note,
    archivedAt: iso(s.archived_at),
  }));
}

async function loadSupplier(trx: Trx, id: string, opts: { lock?: boolean } = {}) {
  if (opts.lock === true) {
    // Serialises edits of one supplier with mappings added to it (archived check).
    await trx.selectFrom('suppliers').select('id').where('id', '=', id).forUpdate().execute();
  }
  const [supplier] = await loadSuppliers(trx, { id });
  if (supplier === undefined) throw notFound();
  return supplier;
}

/** A default currency must be one of the tenant's currencies, and switched on. */
async function assertActiveCurrency(trx: Trx, code: string | null | undefined): Promise<void> {
  if (code === null || code === undefined) return;
  const c = await trx
    .selectFrom('tenant_currencies')
    .select('is_active')
    .where('code', '=', code)
    .executeTakeFirst();
  if (c === undefined) throw new ApiError(400, 'request.invalid');
  if (!c.is_active) throw new ApiError(409, 'currency.inactive');
}

async function loadMappings(
  trx: Trx,
  supplierId: string,
  opts: {
    id?: string;
    q?: string | undefined;
    partId?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<SupplierPartPage> {
  let q = trx
    .selectFrom('supplier_parts as sp')
    .innerJoin('parts as p', (j) =>
      j.onRef('p.tenant_id', '=', 'sp.tenant_id').onRef('p.id', '=', 'sp.part_id'),
    )
    .where('sp.supplier_id', '=', supplierId)
    .where('sp.removed_at', 'is', null);
  if (opts.id !== undefined) q = q.where('sp.id', '=', opts.id);
  if (opts.partId !== undefined) q = q.where('sp.part_id', '=', opts.partId);
  if (opts.q !== undefined && opts.q !== '') {
    const text = opts.q;
    const number = normalizePartNumber(text);
    q = q.where((eb) =>
      eb.or([
        ...(number === '' ? [] : [eb(sql<number>`strpos(sp.number_norm, ${number})`, '>', 0)]),
        eb(sql<number>`strpos(p.search_text, normalize_search(${text}))`, '>', 0),
      ]),
    );
  }
  const counted = await q.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst();
  const rows = await q
    .select([
      'sp.id as mapping_id',
      'sp.supplier_id',
      'sp.number',
      'sp.created_at',
      'p.id',
      'p.sku',
      'p.name_ar',
      'p.name_en',
      'p.quality_grade',
      'p.brand_id',
      'p.category_id',
      'p.unit',
      'p.archived_at',
    ])
    .orderBy('sp.number_norm')
    .orderBy('sp.id')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute();
  const items: SupplierPart[] = rows.map((r) => ({
    id: r.mapping_id,
    supplierId: r.supplier_id,
    number: r.number,
    createdAt: r.created_at.toISOString(),
    part: toPartSummary(r),
  }));
  return { items, total: Number(counted?.total ?? 0) };
}

async function loadMapping(trx: Trx, supplierId: string, id: string): Promise<SupplierPart> {
  const page = await loadMappings(trx, supplierId, { id, limit: 1, offset: 0 });
  const [mapping] = page.items;
  if (mapping === undefined) throw notFound();
  return mapping;
}

async function partSummaries(trx: Trx, ids: readonly string[]): Promise<Map<string, PartSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('parts')
    .select(PART_COLUMNS)
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((r) => [r.id, toPartSummary(r)]));
}

/**
 * Resolves supplier numbers exactly (ADR 0026; never guessed, ADR 0016): this supplier's
 * mapping first; otherwise the active parts whose catalog number or SKU is that number, an
 * archived part standing for the part that replaces it today; otherwise nothing.
 */
async function resolveNumbers(
  trx: Trx,
  supplierId: string,
  numbers: readonly string[],
): Promise<ResolvedSupplierNumber[]> {
  const norms = [...new Set(numbers.map(normalizePartNumber))];
  const mapped = await trx
    .selectFrom('supplier_parts')
    .select(['id', 'number_norm', 'part_id'])
    .where('supplier_id', '=', supplierId)
    .where('removed_at', 'is', null)
    .where('number_norm', 'in', norms)
    .execute();
  const mappingByNorm = new Map(mapped.map((m) => [m.number_norm, m]));
  const unmapped = norms.filter((n) => !mappingByNorm.has(n));

  const { rows: matches } =
    unmapped.length === 0
      ? { rows: [] as { norm: string; part_id: string }[] }
      : await sql<{ norm: string; part_id: string }>`
          SELECT pn.number_norm AS norm, pn.part_id
            FROM part_numbers pn
           WHERE pn.removed_at IS NULL AND pn.number_norm = ANY(${unmapped}::text[])
          UNION
          SELECT p.sku_norm AS norm, p.id AS part_id
            FROM parts p
           WHERE p.sku_norm = ANY(${unmapped}::text[])`.execute(trx);

  const parts = await partSummaries(trx, [
    ...mapped.map((m) => m.part_id),
    ...matches.map((m) => m.part_id),
  ]);
  const archived = [...parts.values()].filter((p) => p.archivedAt !== null).map((p) => p.id);
  const replacementOf = await currentReplacements(trx, archived);
  const replacements = await partSummaries(trx, [...replacementOf.values()]);
  const replacement = (id: string): PartSummary | null => {
    const r = replacementOf.get(id);
    return r === undefined ? null : (replacements.get(r) ?? null);
  };

  const candidatesByNorm = new Map<string, Map<string, PartSummary>>();
  for (const m of matches) {
    const part = parts.get(m.part_id);
    if (part === undefined) continue;
    const offered = part.archivedAt === null ? part : replacement(part.id);
    if (offered === null) continue;
    const list = candidatesByNorm.get(m.norm) ?? new Map<string, PartSummary>();
    list.set(offered.id, offered);
    candidatesByNorm.set(m.norm, list);
  }

  return numbers.map((number) => {
    const norm = normalizePartNumber(number);
    const mapping = mappingByNorm.get(norm);
    const part = mapping === undefined ? undefined : parts.get(mapping.part_id);
    if (mapping !== undefined && part !== undefined) {
      return {
        number,
        status: 'remembered',
        mapping: {
          id: mapping.id,
          part,
          replacement: part.archivedAt === null ? null : replacement(part.id),
        },
        candidates: [],
      };
    }
    const candidates = [...(candidatesByNorm.get(norm)?.values() ?? [])]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .slice(0, MAX_CANDIDATES);
    return {
      number,
      status: candidates.length > 0 ? 'candidates' : 'none',
      mapping: null,
      candidates,
    };
  });
}

/**
 * Suppliers and their part numbers (ADR 0026). Reading needs purchases.view, changing
 * needs purchases.manage. Supplier master data carries no values, so no cost.view.
 */
export function supplierRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/suppliers',
    { schema: { querystring: listSuppliersQuerySchema }, config: { access: VIEW } },
    (request) =>
      inTenant(deps, request, (trx) =>
        loadSuppliers(trx, {
          q: request.query.q,
          includeArchived: request.query.includeArchived === true,
        }),
      ),
  );

  r.get(
    '/suppliers/:id',
    { schema: { params: idParamsSchema }, config: { access: VIEW } },
    (request) => inTenant(deps, request, (trx) => loadSupplier(trx, request.params.id)),
  );

  r.post(
    '/suppliers',
    { schema: { body: createSupplierSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const b = request.body;
      const result = await retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const [existing] = await loadSuppliers(trx, { id: b.id });
          if (existing !== undefined) {
            // A retry of the same create returns the supplier; another body is a conflict.
            const same =
              existing.name === b.name &&
              existing.defaultCurrency === (b.defaultCurrency ?? null) &&
              existing.phone === (b.phone ?? null) &&
              existing.note === (b.note ?? null);
            if (!same) throw new ApiError(409, 'idempotency.conflict');
            return { supplier: existing, created: false };
          }
          await assertActiveCurrency(trx, b.defaultCurrency);
          await trx
            .insertInto('suppliers')
            .values({
              id: b.id,
              tenant_id: auth.tenantId,
              name: b.name,
              default_currency: b.defaultCurrency ?? null,
              phone: b.phone ?? null,
              note: b.note ?? null,
            })
            .execute();
          const created = await loadSupplier(trx, b.id);
          await audit(
            trx,
            actorOf(request),
            { action: 'supplier.create', entityType: 'supplier', entityId: b.id, after: created },
            deps.now(),
          );
          return { supplier: created, created: true };
        }),
      );
      return reply.code(result.created ? 201 : 200).send(result.supplier);
    },
  );

  r.patch(
    '/suppliers/:id',
    { schema: { params: idParamsSchema, body: updateSupplierSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const b = request.body;
        const before = await loadSupplier(trx, id, { lock: true });
        if (b.defaultCurrency !== undefined && b.defaultCurrency !== before.defaultCurrency) {
          await assertActiveCurrency(trx, b.defaultCurrency);
        }
        const archivedAt =
          b.archived === undefined
            ? undefined
            : b.archived
              ? before.archivedAt === null
                ? deps.now()
                : undefined
              : null;
        const changes = {
          ...(b.name !== undefined && { name: b.name }),
          ...(b.defaultCurrency !== undefined && { default_currency: b.defaultCurrency }),
          ...(b.phone !== undefined && { phone: b.phone }),
          ...(b.note !== undefined && { note: b.note }),
          ...(archivedAt !== undefined && { archived_at: archivedAt }),
        };
        if (Object.keys(changes).length > 0) {
          await trx.updateTable('suppliers').set(changes).where('id', '=', id).execute();
        }
        const after = await loadSupplier(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'supplier.update', entityType: 'supplier', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );

  r.get(
    '/suppliers/:id/parts',
    {
      schema: { params: idParamsSchema, querystring: listSupplierPartsQuerySchema },
      config: { access: VIEW },
    },
    (request) =>
      inTenant(deps, request, async (trx) => {
        await loadSupplier(trx, request.params.id);
        return loadMappings(trx, request.params.id, request.query);
      }),
  );

  r.post(
    '/suppliers/:id/parts',
    { schema: { params: idParamsSchema, body: addSupplierPartSchema }, config: { access: MANAGE } },
    async (request, reply) => {
      const supplierId = request.params.id;
      const b = request.body;
      const result = await retryOnDuplicate(() =>
        inTenant(deps, request, async (trx, auth) => {
          const supplier = await loadSupplier(trx, supplierId, { lock: true });
          const norm = normalizePartNumber(b.number);
          const byId = await trx
            .selectFrom('supplier_parts')
            .select(['supplier_id', 'part_id', 'number'])
            .where('id', '=', b.id)
            .executeTakeFirst();
          if (byId !== undefined) {
            // A retry of the same request returns the mapping; another body is a conflict.
            const same =
              byId.supplier_id === supplierId &&
              byId.part_id === b.partId &&
              byId.number === b.number;
            if (!same) throw new ApiError(409, 'idempotency.conflict');
            return { mapping: await loadMapping(trx, supplierId, b.id), created: false };
          }
          const active = await trx
            .selectFrom('supplier_parts')
            .select(['id', 'part_id'])
            .where('supplier_id', '=', supplierId)
            .where('number_norm', '=', norm)
            .where('removed_at', 'is', null)
            .executeTakeFirst();
          if (active !== undefined) {
            // The same number already maps to this part: nothing to add.
            if (active.part_id !== b.partId) throw new ApiError(409, 'supplier_part.taken');
            return { mapping: await loadMapping(trx, supplierId, active.id), created: false };
          }
          if (supplier.archivedAt !== null) throw new ApiError(409, 'supplier.archived');
          const part = await trx
            .selectFrom('parts')
            .select('archived_at')
            .where('id', '=', b.partId)
            .executeTakeFirst();
          if (part === undefined) throw notFound();
          if (part.archived_at !== null) throw new ApiError(409, 'catalog.archived');
          await trx
            .insertInto('supplier_parts')
            .values({
              id: b.id,
              tenant_id: auth.tenantId,
              supplier_id: supplierId,
              part_id: b.partId,
              number: b.number,
              created_by: auth.userId,
            })
            .execute();
          await audit(
            trx,
            actorOf(request),
            {
              action: 'supplier_part.add',
              entityType: 'supplier',
              entityId: supplierId,
              after: { mappingId: b.id, partId: b.partId, number: b.number },
            },
            deps.now(),
          );
          return { mapping: await loadMapping(trx, supplierId, b.id), created: true };
        }),
      );
      return reply.code(result.created ? 201 : 200).send(result.mapping);
    },
  );

  r.post(
    '/suppliers/:id/parts/:mappingId/remove',
    { schema: { params: mappingParamsSchema }, config: { access: MANAGE } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id, mappingId } = request.params;
        const removed = await trx
          .updateTable('supplier_parts')
          .set({ removed_at: deps.now(), removed_by: auth.userId })
          .where('id', '=', mappingId)
          .where('supplier_id', '=', id)
          .where('removed_at', 'is', null)
          .returning(['part_id', 'number'])
          .executeTakeFirst();
        if (removed === undefined) throw notFound();
        await audit(
          trx,
          actorOf(request),
          {
            action: 'supplier_part.remove',
            entityType: 'supplier',
            entityId: id,
            before: { mappingId, partId: removed.part_id, number: removed.number },
          },
          deps.now(),
        );
        return { removed: true };
      }),
  );

  r.post(
    '/suppliers/:id/resolve',
    {
      schema: { params: idParamsSchema, body: resolveSupplierNumbersSchema },
      config: { access: VIEW },
    },
    (request) =>
      inTenant(deps, request, async (trx) => {
        await loadSupplier(trx, request.params.id);
        return { results: await resolveNumbers(trx, request.params.id, request.body.numbers) };
      }),
  );
}
