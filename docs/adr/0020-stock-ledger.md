# 0020. Stock ledger, concurrency and negative stock

- Status: Accepted
- Date: 2026-10-06

## Context

Stock must be exact under concurrent use (two tills, a back office), append-only
(invariant 3), auditable, and still allow selling offline (CLAUDE.md). The tenant setting
`inventory.allowNegativeStock` decides whether online operations may go below zero; the
pilot shop denies it. Offline sales that took the last unit on two devices are accepted
and flagged for review (product owner, 2026-10-06).

## Decision

- **One record of stock**: `stock_moves`, append-only (`forbid_mutation`; the app role has
  no UPDATE or DELETE). Every move belongs to a `stock_documents` row whose id the client
  chooses (invariant 5) and which records the origin (`online`/`offline`), the device and
  a SHA-256 of the request.
- **Derived tables written only by the database**: `stock_balances` (quantity per part and
  location) and `stock_costs` (quantity and value per part, ADR 0021). An `AFTER INSERT`
  trigger on `stock_moves` (`SECURITY DEFINER` with a fixed `search_path`; RLS still
  forced) maintains them; the app role may only read them.
- **Quantities are whole units** (product owner, 2026-10-06): `integer`, signed by
  direction. Each kind has a sign rule in a CHECK (opening in, transfer out/in, lost and
  damaged out, found in, data correction either way, cost adjustment zero).
- **Concurrency**:
  1. The engine calls `lock_stock_costs(part ids)`, which creates missing cost rows and
     locks them in id order, so two writers never deadlock.
  2. It computes every move from that state in TypeScript (one writer: `engine.ts`; a test
     fails if another file inserts moves).
  3. Each move carries the state it was computed from (part quantity and value, location
     quantity). The trigger refuses a move whose snapshot is not the current state with
     SQLSTATE 40001 (`stock.concurrent_change`, retryable). Rows of one INSERT apply in
     order, each against the state left by the previous one.
     So the last unit can never be sold twice online: the second writer waits for the lock
     and then sees zero.
- **Negative stock**:
  - Online, a move that takes a location below zero is refused inside the trigger, under
    the lock, unless the tenant allows negative stock (`ST001` → `stock.insufficient`).
  - Offline documents are always accepted (the sale already happened).
  - Every move that leaves a location below zero, and every issue made with no known
    cost, opens a `stock_review_items` row. An item is resolved once, with a note, and
    only when the problem is gone (the location is back at or above zero, or the part's
    cost is known); corrections are new documents, never edits.
- **Server order**: moves apply in the order the server records them (`seq`); offline
  documents synced later apply then, not at their `occurred_at`.
- **Idempotency**: posting a document with an existing id and the same request hash returns
  the stored result; a different hash is `idempotency.conflict`.
- **Guards**: a part or location with a non-zero balance cannot be archived, nor a part's
  unit changed (`ST003` → `stock.has_stock`); moves into an archived location are refused
  (`ST002`).
- **Ledger**: each document with a value change queues one `ledger_queue` event (functional
  amounts by move kind and reason) for the ledger sprint (product owner, 2026-10-06).
  Transfers between locations change no value and queue nothing.

## Alternatives considered

- **Balances updated by the application**: one missed code path corrupts stock; the trigger
  makes the derived tables impossible to write any other way.
- **SERIALIZABLE transactions instead of locks and snapshots**: retries would be frequent
  on busy parts and the failure would surface far from its cause.
- **Rejecting offline sales that oversell**: the customer already left with the part; the
  review item makes the gap visible instead.

## Consequences

- A reconciliation test checks that the sums of the moves equal the derived tables.
- Sales, receipts and returns (later sprints) post through the same engine.
- Offline moves synced after an approved count are a rare case handled with POS sync.
