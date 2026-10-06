import type { CurrencySpec, Decimal, RoundingMode } from '../money';
import { assertCurrencySpec, dec, divideRounded, formatFixed } from '../money';
import { assertQuantity } from './quantity';

/**
 * Average cost (AVCO) of one part across all locations, in the functional currency
 * (ADR 0021). The average itself is never stored or rounded: it is value / quantity.
 */
export interface CostState {
  /** On hand across all locations. Negative after accepted offline sales beyond stock. */
  readonly quantity: number;
  /** Stock value at the functional currency's minor units; same sign as quantity, 0 at 0. */
  readonly value: string;
  /**
   * The latest known unit cost, as a ratio refValue / refQuantity: the last position with
   * positive quantity, or the last receipt if it left the quantity at or below zero. It
   * prices units issued beyond what is on hand. Null until the part first had stock.
   */
  readonly refQuantity: number | null;
  readonly refValue: string | null;
}

export interface AvcoContext {
  /** The tenant's functional currency. */
  readonly spec: CurrencySpec;
  /** The tenant's rounding mode. */
  readonly mode: RoundingMode;
}

export const EMPTY_COST_STATE: CostState = {
  quantity: 0,
  value: '0',
  refQuantity: null,
  refValue: null,
};

export interface IssueResult {
  readonly state: CostState;
  /** Value taken out of stock, at the functional currency's minor units. */
  readonly cost: string;
  /** False when some units were issued with no known cost (they cost 0 until a receipt). */
  readonly costKnown: boolean;
}

export interface ReceiptResult {
  readonly state: CostState;
  /**
   * Change to stock value, beyond the receipt itself, for units that were issued while
   * stock was negative: their cost is trued up to the receipt's unit cost. Posted as a
   * zero-quantity cost adjustment move BEFORE the receipt move, so every intermediate
   * state stays consistent; negative means value leaves stock (more cost).
   */
  readonly adjustment: string;
}

function checkState(s: CostState, spec: CurrencySpec): Decimal {
  if (!Number.isSafeInteger(s.quantity)) throw new RangeError('Quantity must be an integer');
  const v = dec(s.value);
  if (v.decimalPlaces() > spec.minorUnits) throw new RangeError('Value is not at currency scale');
  const consistent = s.quantity === 0 ? v.isZero() : s.quantity > 0 ? v.gte(0) : v.lte(0);
  if (!consistent) throw new RangeError('Value and quantity disagree');
  if ((s.refQuantity === null) !== (s.refValue === null)) {
    throw new RangeError('Reference position is incomplete');
  }
  if (s.refQuantity !== null && (!Number.isSafeInteger(s.refQuantity) || s.refQuantity <= 0)) {
    throw new RangeError('Reference quantity must be a positive integer');
  }
  return v;
}

/** Quantities are safe integers, so their decimal string is exact. */
function units(quantity: number): Decimal {
  return dec(String(quantity));
}

function format(value: Decimal, spec: CurrencySpec): string {
  return formatFixed(value, spec.minorUnits);
}

/**
 * The state after a move. The database trigger applies the same rule (ADR 0021): a positive
 * position becomes the reference; otherwise a receipt's own unit cost does.
 */
function nextState(
  quantity: number,
  value: Decimal,
  before: CostState,
  spec: CurrencySpec,
  receipt?: { quantity: number; value: Decimal },
): CostState {
  const v = format(value, spec);
  if (quantity > 0) return { quantity, value: v, refQuantity: quantity, refValue: v };
  if (receipt !== undefined) {
    return {
      quantity,
      value: v,
      refQuantity: receipt.quantity,
      refValue: format(receipt.value, spec),
    };
  }
  return { quantity, value: v, refQuantity: before.refQuantity, refValue: before.refValue };
}

/** The unit cost used for the next issue, or null when the part never had stock. */
export function unitCost(s: CostState): Decimal | null {
  if (s.quantity > 0) return dec(s.value).div(units(s.quantity));
  if (s.refQuantity === null || s.refValue === null) return null;
  return dec(s.refValue).div(units(s.refQuantity));
}

/** Takes `quantity` units out of stock at the average cost. */
export function issueCost(before: CostState, quantity: number, ctx: AvcoContext): IssueResult {
  assertCurrencySpec(ctx.spec);
  assertQuantity(quantity);
  const v = checkState(before, ctx.spec);
  const { minorUnits } = ctx.spec;
  const q = before.quantity;

  if (q >= quantity) {
    // Enough on hand: the last units take whatever value is left, so nothing drifts.
    const cost =
      q === quantity ? v : divideRounded(v.times(units(quantity)), units(q), minorUnits, ctx.mode);
    return {
      state: nextState(q - quantity, v.minus(cost), before, ctx.spec),
      cost: format(cost, ctx.spec),
      costKnown: true,
    };
  }

  // Not enough: what is on hand goes at its full value; the rest at the last average.
  const fromStock = q > 0 ? v : dec('0');
  const beyond = quantity - Math.max(q, 0);
  let beyondCost = dec('0');
  let costKnown = true;
  if (q > 0) {
    beyondCost = divideRounded(v.times(units(beyond)), units(q), minorUnits, ctx.mode);
  } else if (before.refQuantity !== null && before.refValue !== null) {
    beyondCost = divideRounded(
      dec(before.refValue).times(units(beyond)),
      units(before.refQuantity),
      minorUnits,
      ctx.mode,
    );
  } else {
    costKnown = false;
  }
  const cost = fromStock.plus(beyondCost);
  return {
    state: nextState(q - quantity, v.minus(cost), before, ctx.spec),
    cost: format(cost, ctx.spec),
    costKnown,
  };
}

/** Puts `quantity` units into stock with a total `value` (functional currency, minor units). */
export function receiveCost(
  before: CostState,
  quantity: number,
  value: string,
  ctx: AvcoContext,
): ReceiptResult {
  assertCurrencySpec(ctx.spec);
  assertQuantity(quantity);
  const v = checkState(before, ctx.spec);
  const incoming = dec(value);
  if (incoming.lt(0)) throw new RangeError('Receipt value must not be negative');
  if (incoming.decimalPlaces() > ctx.spec.minorUnits) {
    throw new RangeError('Receipt value is not at currency scale');
  }
  const q = before.quantity;
  let adjustment = dec('0');
  if (q < 0) {
    // The first `covered` units replace units already sold at an estimated cost.
    const covered = Math.min(quantity, -q);
    const booked =
      covered === -q
        ? v
        : divideRounded(v.times(units(covered)), units(-q), ctx.spec.minorUnits, ctx.mode);
    const actual =
      covered === quantity
        ? incoming
        : divideRounded(
            incoming.times(units(covered)),
            units(quantity),
            ctx.spec.minorUnits,
            ctx.mode,
          );
    // booked is <= 0 (value already taken out); the sold units really cost `actual`.
    adjustment = booked.neg().minus(actual);
  }
  return {
    state: nextState(q + quantity, v.plus(incoming).plus(adjustment), before, ctx.spec, {
      quantity,
      value: incoming,
    }),
    adjustment: format(adjustment, ctx.spec),
  };
}
