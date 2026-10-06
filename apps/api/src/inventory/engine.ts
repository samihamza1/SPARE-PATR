import type {
  AdjustmentReason,
  AvcoContext,
  CostState,
  MoveKind,
  StockDocumentKind,
} from '@autoparts/shared';
import {
  EMPTY_COST_STATE,
  applyMove,
  dec,
  formatFixed,
  issueCost,
  newId,
  receiveCost,
} from '@autoparts/shared';
import { sql } from 'kysely';
import { ApiError } from '../errors';
import type { Trx } from '../routes/common';
import type { MoneyContext } from '../tenant-settings';
import type { ValuedAmount } from './fx';
import { functionalAmount } from './fx';

/**
 * The only code that writes stock_moves (ADR 0020; a test fails if another file does).
 *
 * A document asks for operations; the engine locks the parts' cost rows, computes every
 * move from that state with the AVCO rules (ADR 0021) and inserts the moves with the state
 * each was computed from. The database applies them and refuses any stale one.
 */

export interface StockDocumentHeader {
  readonly id: string;
  readonly kind: StockDocumentKind;
  readonly requestHash: Buffer;
  readonly note: string | null;
  readonly occurredAt: Date;
  readonly origin: 'online' | 'offline';
  readonly deviceId: string | null;
  readonly postedBy: string;
}

type ValuedKind = Extract<MoveKind, 'opening' | 'adjustment' | 'count'>;

export type StockOp =
  /** Stock in with a known total value (opening stock, found units with an entered cost). */
  | {
      readonly op: 'receive';
      readonly partId: string;
      readonly locationId: string;
      readonly quantity: number;
      readonly kind: ValuedKind;
      readonly reason?: AdjustmentReason;
      readonly value: ValuedAmount;
    }
  /** Stock in at the part's current average cost; refused if no cost is known yet. */
  | {
      readonly op: 'receive_at_average';
      readonly partId: string;
      readonly locationId: string;
      readonly quantity: number;
      readonly kind: Extract<ValuedKind, 'adjustment' | 'count'>;
      readonly reason?: AdjustmentReason;
    }
  /** Stock out at the average cost. */
  | {
      readonly op: 'issue';
      readonly partId: string;
      readonly locationId: string;
      readonly quantity: number;
      readonly kind: Extract<ValuedKind, 'adjustment' | 'count'>;
      readonly reason?: AdjustmentReason;
    }
  /** Between locations, at the average cost; the part's cost does not change. */
  | {
      readonly op: 'transfer';
      readonly partId: string;
      readonly fromLocationId: string;
      readonly toLocationId: string;
      readonly quantity: number;
    }
  /** From a superseded part to its replacement at one location (on request only). */
  | {
      readonly op: 'part_transfer';
      readonly fromPartId: string;
      readonly toPartId: string;
      readonly locationId: string;
      readonly quantity: number;
    };

interface MoveRow {
  id: string;
  tenant_id: string;
  document_id: string;
  line_no: number;
  part_id: string;
  location_id: string | null;
  kind: MoveKind;
  reason: AdjustmentReason | null;
  quantity: number;
  amount: string;
  currency: string;
  fx_rate: string;
  fx_base: string;
  fx_quote: string;
  fx_rate_id: string | null;
  functional_amount: string;
  cost_known: boolean;
  prev_part_quantity: number;
  prev_part_value: string;
  prev_location_quantity: number | null;
  occurred_at: Date;
}

/** Locks the parts' cost rows in a fixed order and returns their state. */
export async function lockStockCosts(trx: Trx, partIds: readonly string[]) {
  const ids = [...new Set(partIds)].sort();
  const states = new Map<string, CostState>();
  if (ids.length === 0) return states;
  const { rows } = await sql<{
    part_id: string;
    quantity: number;
    value: string;
    ref_quantity: number | null;
    ref_value: string | null;
  }>`SELECT * FROM lock_stock_costs(${ids}::uuid[])`.execute(trx);
  for (const r of rows) {
    states.set(r.part_id, {
      quantity: r.quantity,
      value: r.value,
      refQuantity: r.ref_quantity,
      refValue: r.ref_value,
    });
  }
  return states;
}

const key = (partId: string, locationId: string) => `${partId}|${locationId}`;

/** The same amounts taken out of stock; keeps each string's scale ("1.50" -> "-1.50"). */
function negate(v: ValuedAmount): ValuedAmount {
  const neg = (s: string) => (dec(s).isZero() ? s : s.startsWith('-') ? s.slice(1) : `-${s}`);
  return { ...v, amount: neg(v.amount), functionalAmount: neg(v.functionalAmount) };
}

/**
 * Posts a stock document: inserts its header and moves in the caller's transaction and
 * returns the moves in order. Online documents may not take a location below zero when
 * the tenant denies negative stock (the database decides, under the lock).
 */
export async function postStockDocument(
  trx: Trx,
  tenantId: string,
  header: StockDocumentHeader,
  ops: readonly StockOp[],
  money: MoneyContext,
): Promise<MoveRow[]> {
  const ctx: AvcoContext = { spec: money.functional, mode: money.roundingMode };
  const fmt = (s: string) => formatFixed(dec(s), money.functional.minorUnits);

  await trx
    .insertInto('stock_documents')
    .values({
      id: header.id,
      tenant_id: tenantId,
      kind: header.kind,
      request_hash: header.requestHash,
      note: header.note,
      occurred_at: header.occurredAt,
      origin: header.origin,
      device_id: header.deviceId,
      posted_by: header.postedBy,
    })
    .execute();

  const partIds = ops.flatMap((o) =>
    o.op === 'part_transfer' ? [o.fromPartId, o.toPartId] : [o.partId],
  );
  const states = await lockStockCosts(trx, partIds);
  const pairs = ops.flatMap((o) => {
    switch (o.op) {
      case 'transfer':
        return [key(o.partId, o.fromLocationId), key(o.partId, o.toLocationId)];
      case 'part_transfer':
        return [key(o.fromPartId, o.locationId), key(o.toPartId, o.locationId)];
      default:
        return [key(o.partId, o.locationId)];
    }
  });
  const balances = new Map<string, number>();
  if (pairs.length > 0) {
    const rows = await trx
      .selectFrom('stock_balances')
      .select(['part_id', 'location_id', 'quantity'])
      .where('part_id', 'in', [...new Set(partIds)])
      .execute();
    for (const r of rows) balances.set(key(r.part_id, r.location_id), r.quantity);
  }

  const moves: MoveRow[] = [];
  const stateOf = (partId: string) => states.get(partId) ?? EMPTY_COST_STATE;
  const balanceOf = (partId: string, locationId: string) =>
    balances.get(key(partId, locationId)) ?? 0;

  function push(
    partId: string,
    locationId: string | null,
    kind: MoveKind,
    reason: AdjustmentReason | null,
    quantity: number,
    value: ValuedAmount,
    costKnown = true,
  ): void {
    const before = stateOf(partId);
    const prevLocation = locationId === null ? null : balanceOf(partId, locationId);
    moves.push({
      id: newId(),
      tenant_id: tenantId,
      document_id: header.id,
      line_no: moves.length,
      part_id: partId,
      location_id: locationId,
      kind,
      reason,
      quantity,
      amount: value.amount,
      currency: value.currency,
      fx_rate: value.fxRate,
      fx_base: value.fxBase,
      fx_quote: value.fxQuote,
      fx_rate_id: value.fxRateId,
      functional_amount: value.functionalAmount,
      cost_known: costKnown,
      prev_part_quantity: before.quantity,
      prev_part_value: before.value,
      prev_location_quantity: prevLocation,
      occurred_at: header.occurredAt,
    });
    states.set(partId, applyMove(before, quantity, value.functionalAmount, ctx));
    if (locationId !== null && prevLocation !== null) {
      balances.set(key(partId, locationId), prevLocation + quantity);
    }
  }

  /** A receipt: a cost true-up for units sold below zero goes first (ADR 0021). */
  function receive(
    partId: string,
    locationId: string,
    kind: MoveKind,
    reason: AdjustmentReason | null,
    quantity: number,
    value: ValuedAmount,
  ): void {
    const r = receiveCost(stateOf(partId), quantity, fmt(value.functionalAmount), ctx);
    if (!dec(r.adjustment).isZero()) {
      push(
        partId,
        null,
        'cost_adjustment',
        null,
        0,
        functionalAmount(r.adjustment, money.functional),
      );
    }
    push(partId, locationId, kind, reason, quantity, value);
  }

  function requireStock(partId: string, locationId: string, quantity: number): void {
    if (balanceOf(partId, locationId) < quantity) throw new ApiError(409, 'stock.insufficient');
  }

  for (const o of ops) {
    switch (o.op) {
      case 'receive':
        receive(o.partId, o.locationId, o.kind, o.reason ?? null, o.quantity, o.value);
        break;
      case 'receive_at_average': {
        const valued = issueCost(stateOf(o.partId), o.quantity, ctx);
        if (!valued.costKnown) throw new ApiError(409, 'stock.cost_required');
        const value = functionalAmount(valued.cost, money.functional);
        receive(o.partId, o.locationId, o.kind, o.reason ?? null, o.quantity, value);
        break;
      }
      case 'issue': {
        const r = issueCost(stateOf(o.partId), o.quantity, ctx);
        const value = negate(functionalAmount(r.cost, money.functional));
        push(o.partId, o.locationId, o.kind, o.reason ?? null, -o.quantity, value, r.costKnown);
        break;
      }
      case 'transfer': {
        requireStock(o.partId, o.fromLocationId, o.quantity);
        const value = functionalAmount(
          issueCost(stateOf(o.partId), o.quantity, ctx).cost,
          money.functional,
        );
        push(o.partId, o.fromLocationId, 'transfer_out', null, -o.quantity, negate(value));
        push(o.partId, o.toLocationId, 'transfer_in', null, o.quantity, value);
        break;
      }
      case 'part_transfer': {
        requireStock(o.fromPartId, o.locationId, o.quantity);
        const out = issueCost(stateOf(o.fromPartId), o.quantity, ctx);
        const value = functionalAmount(out.cost, money.functional);
        push(o.fromPartId, o.locationId, 'part_transfer_out', null, -o.quantity, negate(value));
        receive(o.toPartId, o.locationId, 'part_transfer_in', null, o.quantity, value);
        break;
      }
    }
  }

  if (moves.length > 0) {
    // One statement: the AFTER ROW trigger applies the rows in this order.
    await trx.insertInto('stock_moves').values(moves).execute();
  }
  await queueLedgerEvent(trx, tenantId, header, moves, money.functional.code);
  return moves;
}

/**
 * Queues the document's value changes for the ledger sprint (product owner, 2026-10-06):
 * functional amounts summed by move kind and reason. Transfers between locations change no
 * value and are left out; a document with nothing left queues nothing.
 */
async function queueLedgerEvent(
  trx: Trx,
  tenantId: string,
  header: StockDocumentHeader,
  moves: readonly MoveRow[],
  currency: string,
): Promise<void> {
  const totals = new Map<
    string,
    { kind: MoveKind; reason: AdjustmentReason | null; amount: ReturnType<typeof dec> }
  >();
  for (const m of moves) {
    if (m.kind === 'transfer_out' || m.kind === 'transfer_in') continue;
    const k = `${m.kind}|${m.reason ?? ''}`;
    const t = totals.get(k) ?? { kind: m.kind, reason: m.reason, amount: dec('0') };
    t.amount = t.amount.plus(dec(m.functional_amount));
    totals.set(k, t);
  }
  const lines = [...totals.values()]
    .filter((t) => !t.amount.isZero())
    .map((t) => ({ kind: t.kind, reason: t.reason, functionalAmount: t.amount.toFixed() }));
  if (lines.length === 0) return;
  await trx
    .insertInto('ledger_queue')
    .values({
      id: newId(),
      tenant_id: tenantId,
      document_id: header.id,
      event: `stock.${header.kind}`,
      payload: JSON.stringify({ currency, occurredAt: header.occurredAt.toISOString(), lines }),
    })
    .execute();
}
