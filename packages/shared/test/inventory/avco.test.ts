import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AvcoContext, CostState } from '../../src/inventory';
import { EMPTY_COST_STATE, issueCost, receiveCost, unitCost } from '../../src/inventory';
import { dec } from '../../src/money';
import { roundingModeArb, scaledDecimalArb } from '../money/arbitraries';

// The functional currency is tenant configuration; tests use a fictional one.
const ctx: AvcoContext = { spec: { code: 'FUN', minorUnits: 2 }, mode: 'HALF_UP' };

function state(quantity: number, value: string, ref?: [number, string]): CostState {
  return {
    quantity,
    value,
    refQuantity: ref?.[0] ?? null,
    refValue: ref?.[1] ?? null,
  };
}

describe('receiving and issuing with stock on hand', () => {
  it('adds receipts to quantity and value', () => {
    const r = receiveCost(EMPTY_COST_STATE, 3, '30.00', ctx);
    expect(r).toEqual({ state: state(3, '30.00', [3, '30.00']), adjustment: '0.00' });
    expect(receiveCost(r.state, 2, '25.00', ctx).state).toEqual(state(5, '55.00', [5, '55.00']));
  });

  it('issues at the average, rounding once, and the last unit takes what is left', () => {
    const s = state(3, '10.00', [3, '10.00']);
    const first = issueCost(s, 1, ctx); // 10 / 3 = 3.333...
    expect(first).toEqual({ state: state(2, '6.67', [2, '6.67']), cost: '3.33', costKnown: true });
    const second = issueCost(first.state, 2, ctx);
    expect(second).toEqual({ state: state(0, '0.00', [2, '6.67']), cost: '6.67', costKnown: true });
  });

  it('reports the unit cost of the last positive position', () => {
    expect(unitCost(state(4, '10.00', [4, '10.00']))?.toFixed()).toBe('2.5');
    expect(unitCost(state(0, '0.00', [4, '10.00']))?.toFixed()).toBe('2.5');
    expect(unitCost(EMPTY_COST_STATE)).toBeNull();
  });
});

describe('negative stock (accepted offline sales, ADR 0019)', () => {
  it('issues beyond zero at the last positive average', () => {
    const r = issueCost(state(1, '10.00', [1, '10.00']), 3, ctx);
    expect(r).toEqual({ state: state(-2, '-20.00', [1, '10.00']), cost: '30.00', costKnown: true });
  });

  it('issues with no known cost at zero and says so', () => {
    const r = issueCost(EMPTY_COST_STATE, 2, ctx);
    expect(r).toEqual({ state: state(-2, '0.00'), cost: '0.00', costKnown: false });
  });

  it('a receipt that covers the shortfall trues up the cost of the units already sold', () => {
    // Two units were sold at 10 each; they really cost 12 (the receipt's unit cost).
    const r = receiveCost(state(-2, '-20.00', [1, '10.00']), 5, '60.00', ctx);
    // 3 units remain at 12; the extra 4.00 leaves inventory as a 0-quantity cost adjustment.
    expect(r).toEqual({ state: state(3, '36.00', [3, '36.00']), adjustment: '-4.00' });
  });

  it('a receipt that only partly covers the shortfall keeps the rest at the old average', () => {
    const r = receiveCost(state(-5, '-50.00', [1, '10.00']), 2, '24.00', ctx);
    expect(r).toEqual({ state: state(-3, '-30.00', [1, '10.00']), adjustment: '-4.00' });
  });

  it('units sold with no known cost take their cost from the receipt', () => {
    const r = receiveCost(state(-2, '0.00'), 4, '40.00', ctx);
    expect(r).toEqual({ state: state(2, '20.00', [2, '20.00']), adjustment: '-20.00' });
  });
});

describe('input checks', () => {
  it('rejects non-integer, zero or negative quantities and badly scaled values', () => {
    expect(() => issueCost(EMPTY_COST_STATE, 1.5, ctx)).toThrow(RangeError);
    expect(() => issueCost(EMPTY_COST_STATE, 0, ctx)).toThrow(RangeError);
    expect(() => receiveCost(EMPTY_COST_STATE, -1, '1.00', ctx)).toThrow(RangeError);
    expect(() => receiveCost(EMPTY_COST_STATE, 1, '-1.00', ctx)).toThrow(RangeError);
    expect(() => receiveCost(EMPTY_COST_STATE, 1, '1.001', ctx)).toThrow(RangeError);
  });

  it('rejects inconsistent states', () => {
    expect(() => issueCost(state(0, '1.00'), 1, ctx)).toThrow(RangeError);
    expect(() => issueCost(state(2, '-1.00'), 1, ctx)).toThrow(RangeError);
    expect(() => issueCost(state(-2, '1.00'), 1, ctx)).toThrow(RangeError);
  });
});

// --- properties ------------------------------------------------------------------------

type Op = { kind: 'in'; qty: number; value: string } | { kind: 'out'; qty: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('in' as const),
    qty: fc.integer({ min: 1, max: 1000 }),
    value: scaledDecimalArb(2, { maxUnits: 10n ** 9n, allowNegative: false }),
  }),
  fc.record({ kind: fc.constant('out' as const), qty: fc.integer({ min: 1, max: 1000 }) }),
);

function run(ops: Op[], c: AvcoContext) {
  let s = EMPTY_COST_STATE;
  let received = dec('0');
  let issued = dec('0');
  let adjusted = dec('0');
  const steps: { before: CostState; op: Op; cost?: string; after: CostState }[] = [];
  for (const op of ops) {
    const before = s;
    if (op.kind === 'in') {
      const r = receiveCost(s, op.qty, op.value, c);
      received = received.plus(dec(op.value));
      adjusted = adjusted.plus(dec(r.adjustment));
      s = r.state;
      steps.push({ before, op, after: s });
    } else {
      const r = issueCost(s, op.qty, c);
      issued = issued.plus(dec(r.cost));
      s = r.state;
      steps.push({ before, op, cost: r.cost, after: s });
    }
  }
  return { s, received, issued, adjusted, steps };
}

describe('AVCO properties', () => {
  const ctxArb = roundingModeArb.map((mode): AvcoContext => ({ spec: ctx.spec, mode }));

  it('conserves value: receipts - issues + adjustments = stock value', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), ctxArb, (ops, c) => {
        const { s, received, issued, adjusted } = run(ops, c);
        expect(received.minus(issued).plus(adjusted).eq(dec(s.value))).toBe(true);
      }),
    );
  });

  it('keeps value at the currency scale and its sign with the quantity (0 with 0)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), ctxArb, (ops, c) => {
        for (const { after } of run(ops, c).steps) {
          const v = dec(after.value);
          expect(v.decimalPlaces()).toBeLessThanOrEqual(2);
          if (after.quantity === 0) expect(v.isZero()).toBe(true);
          if (after.quantity > 0) expect(v.gte(0)).toBe(true);
          if (after.quantity < 0) expect(v.lte(0)).toBe(true);
        }
      }),
    );
  });

  it('issues from positive stock cost within one rounding of the exact average', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), ctxArb, (ops, c) => {
        for (const step of run(ops, c).steps) {
          if (step.op.kind !== 'out' || step.before.quantity < step.op.qty) continue;
          const exact = dec(step.before.value).times(step.op.qty).div(step.before.quantity);
          expect(
            dec(step.cost ?? '0')
              .minus(exact)
              .abs()
              .lt('0.01'),
          ).toBe(true);
        }
      }),
    );
  });

  it('once the stock is back to zero or above, the sold units cost exactly what was received', () => {
    // Over any sequence that ends at quantity 0, everything received was issued or adjusted out.
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), ctxArb, (ops, c) => {
        const { s, received, issued, adjusted } = run(ops, c);
        const total = ops.reduce((q, op) => q + (op.kind === 'in' ? op.qty : -op.qty), 0);
        expect(s.quantity).toBe(total);
        if (s.quantity === 0) expect(issued.minus(adjusted).eq(received)).toBe(true);
      }),
    );
  });

  it('issuing everything on hand leaves exactly zero value', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), ctxArb, (ops, c) => {
        const { s } = run(ops, c);
        if (s.quantity <= 0) return;
        expect(issueCost(s, s.quantity, c).state.value).toBe('0.00');
      }),
    );
  });
});
