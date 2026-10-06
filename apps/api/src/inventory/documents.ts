import type {
  AdjustmentReason,
  MoveKind,
  StockDocument,
  StockDocumentKind,
  StockMove,
  UnitCost,
} from '@autoparts/shared';
import { businessDate, dec, money, round } from '@autoparts/shared';
import type { FastifyRequest } from 'fastify';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { ApiError, notFound } from '../errors';
import type { Trx } from '../routes/common';
import { actorOf } from '../routes/common';
import type { MoneyContext } from '../tenant-settings';
import { seesCost } from './cost-view';
import type { StockOp } from './engine';
import { postStockDocument } from './engine';
import type { ValuedAmount } from './fx';
import { rateInEffect, valueAmount } from './fx';
import { requestHash } from './idempotency';

/** A posted document with its moves; values only with cost.view (ADR 0022). */
export async function loadStockDocument(
  trx: Trx,
  id: string,
  auth: Pick<AuthContext, 'permissions'>,
): Promise<StockDocument> {
  const doc = await trx
    .selectFrom('stock_documents')
    .select(['id', 'kind', 'note', 'origin', 'occurred_at', 'posted_at', 'posted_by'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (doc === undefined) throw notFound();
  const rows = await trx
    .selectFrom('stock_moves')
    .selectAll()
    .where('document_id', '=', id)
    .orderBy('line_no')
    .execute();
  const showCost = seesCost(auth);
  const moves: StockMove[] = rows.map((m) => ({
    id: m.id,
    seq: m.seq,
    documentId: m.document_id,
    documentKind: doc.kind as StockDocumentKind,
    lineNo: m.line_no,
    partId: m.part_id,
    locationId: m.location_id,
    kind: m.kind as MoveKind,
    reason: m.reason as AdjustmentReason | null,
    quantity: m.quantity,
    occurredAt: m.occurred_at.toISOString(),
    recordedAt: m.recorded_at.toISOString(),
    ...(showCost && {
      cost: {
        amount: m.amount,
        currency: m.currency,
        fxRate: m.fx_rate,
        fxBase: m.fx_base,
        fxQuote: m.fx_quote,
        functionalAmount: m.functional_amount,
      },
    }),
  }));
  return {
    id: doc.id,
    kind: doc.kind as StockDocumentKind,
    note: doc.note,
    origin: doc.origin as StockDocument['origin'],
    occurredAt: doc.occurred_at.toISOString(),
    postedAt: doc.posted_at.toISOString(),
    postedBy: doc.posted_by,
    moves,
  };
}

/**
 * Posts a document once (invariant 5). A retry with the same id and the same request
 * returns the posted document; the same id with a different request is a conflict.
 */
export async function postOnce(
  trx: Trx,
  request: FastifyRequest,
  auth: AuthContext,
  doc: { id: string; kind: StockDocumentKind; note: string | null; body: unknown; now: Date },
  build: () => Promise<StockOp[]>,
  money: MoneyContext,
): Promise<StockDocument> {
  const hash = requestHash({ kind: doc.kind, body: doc.body });
  const existing = await trx
    .selectFrom('stock_documents')
    .select('request_hash')
    .where('id', '=', doc.id)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (!Buffer.from(existing.request_hash).equals(hash)) {
      throw new ApiError(409, 'idempotency.conflict');
    }
    return loadStockDocument(trx, doc.id, auth);
  }
  const ops = await build();
  const moves = await postStockDocument(
    trx,
    auth.tenantId,
    {
      id: doc.id,
      kind: doc.kind,
      requestHash: hash,
      note: doc.note,
      occurredAt: doc.now,
      origin: 'online',
      deviceId: null,
      postedBy: auth.userId,
    },
    ops,
    money,
  );
  // Invariant 7: stock adjustments are audited; values stay under `cost` (ADR 0022).
  await audit(
    trx,
    actorOf(request),
    {
      action: `stock.${doc.kind}`,
      entityType: 'stock_document',
      entityId: doc.id,
      after: {
        lines: moves.map((m) => ({
          partId: m.part_id,
          locationId: m.location_id,
          kind: m.kind,
          reason: m.reason,
          quantity: m.quantity,
        })),
        cost: {
          currency: money.functional.code,
          total: moves.reduce((sum, m) => sum.plus(dec(m.functional_amount)), dec('0')).toFixed(),
        },
      },
      reason: doc.note,
    },
    doc.now,
  );
  return loadStockDocument(trx, doc.id, auth);
}

/** True when a pg error is the duplicate-key race on a client-chosen document id. */
export function isDuplicateDocument(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown };
  return (
    e.code === '23505' &&
    ['stock_documents_pkey', 'stock_counts_pkey', 'opening_stock_drafts_pkey'].includes(
      String(e.constraint),
    )
  );
}

/**
 * Runs `fn` again once when two identical requests raced on the same document id: the
 * second one then finds the posted document and returns it.
 */
export async function retryOnDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isDuplicateDocument(error)) throw error;
    return fn();
  }
}

/**
 * Values `quantity` units at `unitCost` (any tenant currency) in the functional currency,
 * at the rate in effect on today's business date: the total is rounded once to the
 * currency's minor units, then converted (invariant 2).
 */
export async function valueUnits(
  trx: Trx,
  m: MoneyContext,
  unitCost: UnitCost,
  quantity: number,
  now: Date,
): Promise<ValuedAmount> {
  const currency = await trx
    .selectFrom('tenant_currencies')
    .select('minor_units')
    .where('code', '=', unitCost.currency)
    .executeTakeFirst();
  if (currency === undefined) throw notFound();
  const total = round(
    dec(unitCost.amount).times(String(quantity)),
    currency.minor_units,
    m.roundingMode,
  );
  const rate =
    unitCost.currency === m.functional.code
      ? null
      : await rateInEffect(
          trx,
          m.functional.code,
          unitCost.currency,
          businessDate(now, m.timezone),
        );
  return valueAmount(money(total, unitCost.currency), rate, m);
}
