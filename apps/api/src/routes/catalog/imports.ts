import { createHash } from 'node:crypto';
import {
  IMPORT_MAX_FILE_BYTES,
  createImportSchema,
  idParamsSchema,
  inspectImportSchema,
  listImportRowsQuerySchema,
  skipImportRowsSchema,
} from '@autoparts/shared';
import type {
  ImportIssue,
  ImportRow,
  InspectImportResult,
  ParsedImportRow,
} from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { audit } from '../../audit';
import type { PlatformDeps } from '../../auth/plugin';
import { ApiError } from '../../errors';
import { readWorkbook } from '../../catalog/import/read';
import {
  analyseBatch,
  applyBatch,
  discardBatch,
  listBatches,
  loadBatchDetail,
  markPreviewed,
  skipRows,
  stageBatch,
} from '../../catalog/import/service';
import { actorOf, inTenant } from '../common';

const IMPORT = 'catalog.import' as const;
/** base64 of the largest file plus the JSON around it. */
const UPLOAD_BODY_LIMIT = Math.ceil(IMPORT_MAX_FILE_BYTES / 3) * 4 + 64 * 1024;
const SAMPLE_ROWS = 30;

function decode(contentBase64: string): Buffer {
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > IMPORT_MAX_FILE_BYTES) {
    throw new ApiError(400, 'import.unreadable_file');
  }
  return bytes;
}

export function importRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const now = () => deps.now();

  // Reads the file and returns its sheets' first rows. Nothing is stored.
  r.post(
    '/catalog/imports/inspect',
    {
      schema: { body: inspectImportSchema },
      config: { access: IMPORT },
      bodyLimit: UPLOAD_BODY_LIMIT,
    },
    async (request): Promise<InspectImportResult> => {
      const sheets = await readWorkbook(decode(request.body.contentBase64), request.body.fileName);
      return {
        sheets: sheets.map((s) => ({
          name: s.name,
          rowCount: s.rows.length,
          columnCount: Math.max(0, ...s.rows.map((row) => row.length)),
          rows: s.rows.slice(0, SAMPLE_ROWS),
        })),
      };
    },
  );

  // Stages the chosen sheet: only the mapped columns of its data rows are stored.
  r.post(
    '/catalog/imports',
    {
      schema: { body: createImportSchema },
      config: { access: IMPORT },
      bodyLimit: UPLOAD_BODY_LIMIT,
    },
    async (request, reply) => {
      const b = request.body;
      const bytes = decode(b.contentBase64);
      const [sheet] = await readWorkbook(bytes, b.fileName, b.sheet);
      const detail = await inTenant(deps, request, async (trx, auth) => {
        await stageBatch(
          trx,
          auth,
          {
            id: b.id,
            fileName: b.fileName,
            sha256: createHash('sha256').update(bytes).digest(),
            sheet: b.sheet,
            headerRow: b.headerRow,
            mapping: b.mapping,
          },
          sheet?.rows ?? [],
        );
        await audit(
          trx,
          actorOf(request),
          {
            action: 'catalog.import_stage',
            entityType: 'import_batch',
            entityId: b.id,
            after: { fileName: b.fileName, sheet: b.sheet, mapping: b.mapping },
          },
          now(),
        );
        return loadBatchDetail(trx, b.id);
      });
      return reply.code(201).send(detail);
    },
  );

  r.get('/catalog/imports', { config: { access: IMPORT } }, (request) =>
    inTenant(deps, request, (trx) => listBatches(trx)),
  );

  r.get(
    '/catalog/imports/:id',
    { schema: { params: idParamsSchema }, config: { access: IMPORT } },
    (request) => inTenant(deps, request, (trx) => loadBatchDetail(trx, request.params.id)),
  );

  r.get(
    '/catalog/imports/:id/rows',
    {
      schema: { params: idParamsSchema, querystring: listImportRowsQuerySchema },
      config: { access: IMPORT },
    },
    (request) =>
      inTenant(deps, request, async (trx, auth): Promise<ImportRow[]> => {
        await loadBatchDetail(trx, request.params.id);
        const f = request.query;
        let q = trx
          .selectFrom('import_rows')
          .select([
            'id',
            'row_number',
            'parsed',
            'issues',
            'decision',
            'skipped_by_user',
            'part_id',
          ])
          .where('batch_id', '=', request.params.id);
        const issue = f.issue;
        if (issue !== undefined) q = q.where(sql<boolean>`${issue} = ANY(issues)`);
        if (f.decision !== undefined) q = q.where('decision', '=', f.decision);
        if (f.after !== undefined) q = q.where('row_number', '>', f.after);
        const rows = await q.orderBy('row_number').limit(f.limit).execute();
        // Costs are shown only to users who may see cost (BRIEF: cashiers cannot).
        const seesCost = auth.permissions.has('cost.view');
        return rows.map((row) => {
          const parsed = { ...(row.parsed as ParsedImportRow) };
          if (!seesCost) delete parsed.cost;
          return {
            id: row.id,
            rowNumber: row.row_number,
            parsed,
            issues: row.issues as ImportIssue[],
            decision: row.decision as ImportRow['decision'],
            skippedByUser: row.skipped_by_user,
            partId: row.part_id,
          };
        });
      }),
  );

  r.post(
    '/catalog/imports/:id/rows/skip',
    { schema: { params: idParamsSchema, body: skipImportRowsSchema }, config: { access: IMPORT } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        await skipRows(trx, request.params.id, request.body.rowIds, request.body.skipped);
        return loadBatchDetail(trx, request.params.id);
      }),
  );

  // Re-analyses after vehicle codes were mapped; the batch is then "previewed".
  r.post(
    '/catalog/imports/:id/analyse',
    { schema: { params: idParamsSchema }, config: { access: IMPORT } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        await analyseBatch(trx, request.params.id, true);
        await markPreviewed(trx, request.params.id);
        return loadBatchDetail(trx, request.params.id);
      }),
  );

  r.post(
    '/catalog/imports/:id/apply',
    { schema: { params: idParamsSchema }, config: { access: IMPORT } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const at = now();
        const stats = await applyBatch(trx, auth, request.params.id, at);
        const detail = await loadBatchDetail(trx, request.params.id);
        await audit(
          trx,
          actorOf(request),
          {
            action: 'catalog.import',
            entityType: 'import_batch',
            entityId: request.params.id,
            after: { fileName: detail.fileName, sheet: detail.sheet, stats },
          },
          at,
        );
        return detail;
      }),
  );

  r.post(
    '/catalog/imports/:id/discard',
    { schema: { params: idParamsSchema }, config: { access: IMPORT } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        await discardBatch(trx, request.params.id);
        await audit(
          trx,
          actorOf(request),
          {
            action: 'catalog.import_discard',
            entityType: 'import_batch',
            entityId: request.params.id,
          },
          now(),
        );
        return loadBatchDetail(trx, request.params.id);
      }),
  );
}
