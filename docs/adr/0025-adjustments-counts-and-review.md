# 0025. Adjustments, transfers, counts and review

- Status: Accepted
- Date: 2026-10-07

## Context

Stock changes outside sales and purchases: damage, loss, finds, data errors, moves between
the shop and the storeroom, replacement parts (supersession) and physical counts. The
product owner decided (2026-10-06) that supervisors and owners adjust stock and approve
counts, that stock moves to a replacement part only on request, and that cashiers may take
part in counts.

## Decision

- **Adjustments** (`stock.adjust`): the reason decides the direction (lost and damaged out,
  found in, data correction either way). Units added take the entered unit cost (any tenant
  currency, converted at the rate in effect today) or the part's average; with no known cost
  a cost must be entered (`stock.cost_required`).
- **Transfers** (`stock.transfer`): between two different active locations, at the average,
  never beyond the source location's quantity, even when the tenant allows negative stock.
- **Replacement parts** (`stock.adjust`): `POST /stock/part-transfers` moves every positive
  balance of a part with an active supersession to its replacement, location by location,
  at the old part's value. The units must match. Shortfalls stay for review.
- **Counts**:
  - Supervisors and owners (`stock.approve_count`) open a count for a location: everything
    with stock there, a category, or a list of parts. One open count per location.
  - Counters (`stock.count`, including cashiers) enter what they see. They never see the
    expected quantity (blind count). Each entry stores the location's quantity at that
    moment, so sales and moves after the entry are not taken for differences.
  - Approval posts `count` moves for the differences (counted − expected at counting time).
    Gains of parts with no known cost take a unit cost given at approval. Uncounted lines
    change nothing. A difference that would take the location below zero now is refused
    under the tenant's rule (the count is reviewed again).
- **Idempotency**: every document, count and opening draft has a client-chosen id; a retry
  with the same request returns the same result, a different request is
  `idempotency.conflict`. A race of two identical requests is retried once.
- **Audit** (invariant 7): every posted document writes a `stock.<kind>` audit entry with
  its lines and, under `cost`, its value (hidden without `cost.view`, ADR 0022).
- **Review items** (`stock.review`): listed with the location's current quantity and
  resolved with a note once the database agrees the problem is gone (ADR 0020).

## Alternatives considered

- **Counting against the quantity at approval time**: sales during a long count would show
  up as shortages.
- **Moving superseded stock automatically**: the product owner wants it on request only.

## Consequences

- Sales, receipts and returns will reuse the same document, idempotency and audit pattern.
- Offline moves synced after an approved count are a rare case handled with POS sync.
