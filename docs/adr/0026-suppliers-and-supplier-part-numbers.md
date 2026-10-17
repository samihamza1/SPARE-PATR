# 0026. Suppliers and supplier part numbers

- Status: Accepted
- Date: 2026-10-17

## Context

Sprint 5 adds purchasing (BRIEF: suppliers, supplier_parts, receipts, landed costs).
Scenario 4 starts from a supplier's invoice whose lines carry the supplier's own part
numbers. Catalog numbers alone are ambiguous: in the pilot data, 322 rows share a number
with a different part (Sky Motors runbook). The product owner decided (2026-10-16) who may
do what: supervisors prepare and post purchases, accountants only view them, cashiers get
nothing, and only owners revalue stock.

## Decision

- **Suppliers** are tenant-local master data (not shared like the vehicle tree, ADR 0013):
  - name, an optional default currency, phone and note;
  - active suppliers have distinct names after normalisation;
  - archiving is soft and reversible. Archived suppliers take no new mappings (and, from
    PR 5b, no new invoices).
  - The default currency must be an active tenant currency (`currency.inactive`).
    It is only proposed: each invoice chooses its own.
- **Supplier part numbers** (`supplier_parts`) are separate from `part_numbers`:
  - Sales search matches every catalog number, and supplier numbers must not reveal
    suppliers at the counter or slow search (ADR 0015).
  - Per supplier, one active number points to exactly one part. The number is compared in
    part-number form (`normalize_part_number`: "GP-0042" = "gp 0042"). A part may carry
    several numbers from one supplier.
  - Quantities are always in stock units: there are no pack sizes.
  - Removal is final (`removed_at`, `removed_by`). Mapping the number again is a new row,
    so the history stays.
  - Mapping the same number to the same part again changes nothing. Mapping it to another
    part is refused (`supplier_part.taken`) until the old mapping is removed.
  - Archived parts take no new mappings (`catalog.archived`).
- **Resolving** (`POST /suppliers/:id/resolve`, up to 500 numbers) never guesses (ADR 0016):
  1. this supplier's active mapping ⇒ `remembered`. When that part is archived, the part
     that replaces it today is offered as `replacement`.
  2. otherwise, active parts whose catalog number or SKU equals the number ⇒ `candidates`.
     An archived match stands for its current replacement. The user picks one, even when
     only one is offered.
  3. otherwise ⇒ `none`.

  Matches are exact: no prefix matching, unlike sales search.

- **Permissions:**
  - `purchases.view` reads suppliers, mappings and resolves numbers.
  - `purchases.manage` changes them.
  - `purchases.post` and `stock.revalue` arrive with receipts (PR 5b) and value changes
    (PR 5d).
  - Default roles: owner all; supervisor view, manage and post; accountant view; cashier
    none; `stock.revalue` owners only. A data migration gives existing tenants' system roles
    the same.
  - Supplier master data carries no values, so it does not need `cost.view`. Every screen
    that shows purchase values does (ADR 0022). `requireCostView` now lives in
    `inventory/cost-view.ts` for all such handlers.
  - The role lists in `packages/shared/src/auth/permissions.ts` are the reference; ADR 0009's
    lists predate the inventory and purchasing permissions.
- **Idempotency.** Creates use client v7 ids:
  - The same request again returns the record (200).
  - The same id with another body is `idempotency.conflict`.
  - Concurrent identical requests are retried once on the duplicate key (`retryOnDuplicate`,
    now driven by a list of retryable keys).
- **Audit:** `supplier.create`, `supplier.update` (before and after),
  `supplier_part.add` and `supplier_part.remove`, all filed under the supplier.

## Consequences

- An invoice line keyed with a known supplier number maps to its part with no search.
  Unknown numbers ask the user once and are remembered.
- The BRIEF's `supplier_parts` exists under that name. Supplier price lists (a price per
  supplier number) are not stored: price-file import is in BRIEF "Later".
- A supplier number that a supplier reuses for another item needs the old mapping removed
  first. This is deliberate, so that a receipt never maps silently to the wrong part.
