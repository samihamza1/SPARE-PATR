# 0021. Average cost (AVCO)

- Status: Accepted
- Date: 2026-10-06

## Context

CLAUDE.md fixes AVCO in the functional currency. The product owner chose one average per
part across all locations (2026-10-06). Averages are non-terminating decimals (10 / 3), so
storing a rounded average and multiplying it out drifts; and negative stock (ADR 0020)
means units can leave before their cost is known.

## Decision

- **State per part** (`stock_costs`): quantity Q, value V in the functional currency at its
  minor units, and the latest known unit cost as a ratio (refQuantity, refValue). The
  average is never stored; it is V / Q, shown rounded only for display.
- **Issuing q units** with Q ≥ q costs `round(V · q / Q)`, computed exactly with bigints and
  rounded once (`divideRounded`, tenant rounding mode). Issuing everything on hand costs
  exactly V, so no residue is ever left at zero quantity.
- **Issuing beyond stock**: what is on hand goes at V, the rest at the latest known unit
  cost (refValue / refQuantity). With no known cost the units cost 0 and a review item
  opens.
- **Receiving** q units with value v adds to Q and V. If Q was negative, the units that
  cover the shortfall are trued up to the receipt's unit cost: a zero-quantity
  `cost_adjustment` move, posted before the receipt so every intermediate state is
  consistent, moves the difference out of stock (to cost of sales in the ledger sprint).
- **Latest known cost**: after any move, a positive position (Q, V) becomes the reference;
  otherwise a receipt's own (q, v) does. The trigger and `applyMove` in TypeScript apply
  the same rule; a property test checks they agree.
- **Transfers** between locations move value at the current average and leave Q and V
  unchanged. Moving stock from a superseded part to its replacement (on request only)
  issues from the old part and receives into the new one at the same value.
- **Consistency** is enforced by CHECKs: Q = 0 ⇒ V = 0, and V has the sign of Q.
- Units added at the average (found, count gains) need a known cost; otherwise the user
  must enter one (`stock.cost_required`).

## Alternatives considered

- **Average per location**: rejected by the product owner; it also makes transfers change
  cost.
- **Storing the average with extra decimals**: still drifts and needs a residue rule.
- **FIFO layers**: more data and work than the shops need; AVCO is what CLAUDE.md asks.

## Consequences

- Property tests (fast-check) check value conservation, rounding bounds, Q = 0 ⇒ V = 0,
  sign consistency and agreement with the trigger rule.
- Value-only revaluation (no quantity) and landed costs come with purchasing (Sprint 5);
  only the internal cost true-up exists now.
