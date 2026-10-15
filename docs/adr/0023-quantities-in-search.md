# 0023. Quantities in search

- Status: Accepted
- Date: 2026-10-07

## Context

A salesperson searching for a part must see at once whether it can be sold now and where
it is (shop floor, storeroom, warehouse). The product owner decided (2026-10-06):

- cashiers see quantities in every location, without cost;
- alternatives are ordered by availability first, then quality grade.

ADR 0015 ordered alternatives by grade, then price.

## Decision

- **Every search hit carries `stock`**: the total on hand and each location holding stock
  (non-zero quantities, negative after accepted offline sales). This applies to results
  and alternatives alike.
  - Quantities only. Values never appear in search (ADR 0022), so a session is enough.
  - Read from `stock_balances` with one query on the hits' part ids (primary key starts
    with tenant and part).
- **Alternatives** are ordered:
  1. in stock (total above zero) first;
  2. then best grade;
  3. then cheapest;
  4. then SKU.

  This replaces ADR 0015's "grade, then price" order.

- **Results keep their relevance order** (number hits, then text similarity). A part
  that is out of stock is still listed, with an "out of stock" mark: the customer may
  order it, and its alternatives in stock are listed under it.
- The back office shows a badge per location ("Shop: 4") or "out of stock".

## Alternatives considered

- **Hiding parts that are out of stock**: the salesperson would not learn that the part
  exists, or that an alternative is on hand.
- **Ordering results by stock too**: a part number that matches exactly must stay first.
- **Stock at the device's location only**: the back office has no device, and a sale can
  be fetched from the storeroom. The POS can still highlight its own location.

## Consequences

- The POS offline index (later) needs the same per-location quantities, synced with stock
  moves.
- Search pays one more indexed query. With it, p95 is 75 ms on 50,000 synthetic parts
  (target 200 ms). The synthetic catalog has no stock yet, so the lookup is measured on an
  empty table; seeding stock into the performance catalog is a follow-up.
