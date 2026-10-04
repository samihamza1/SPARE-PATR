# AutoParts POS & Accounting

## What this is

Multi-tenant SaaS for car spare-parts shops (retail + wholesale to workshops).
Standalone system (NOT Odoo-based). Pilot customer: Sky Motors.
Arabic-first (RTL) with English fallback. Selling must continue offline.
The first customer's country, currencies and tax regime are NOT decided yet:
everything money/tax/locale related is per-tenant configuration.
Never hardcode a currency, tax rate or country rule. If a task needs one, ask.

## Status

Sprint 1 (platform foundation) done. Scope, data model and scenarios: docs/BRIEF.md
(not yet in the repo). Decisions: docs/adr/.

## Stack (confirm each via a short ADR in Sprint 1 before locking)

- TypeScript everywhere; pnpm workspaces monorepo, strict mode.
- apps/api: Node.js REST API. apps/pos: React PWA (offline-first). apps/backoffice: React.
- packages/shared: types, zod schemas, money utils, i18n.
- PostgreSQL is the source of truth. SQL-first migrations in db/migrations/*.sql.
  Typed queries via Kysely (proposal; Drizzle is the alternative).
- POS local store: IndexedDB via Dexie, with an outbox queue for sync.
- Local dev: docker-compose (postgres).

## Non-negotiable invariants

1. Money: NUMERIC in DB, decimal strings in JSON, a decimal library in code.
   Never JS floats for money or FX rates.
2. Every monetary amount stores: amount, currency, fx rate used,
   and the amount in the functional currency.
3. Ledger is double-entry, append-only, balanced per entry (deferred constraint
   trigger). Corrections are reversing entries. The app DB role has no
   UPDATE/DELETE on journal_entries, journal_lines, stock_moves.
4. Tenant isolation: tenant_id on every tenant table + Row-Level Security with
   FORCE; app role has no BYPASSRLS; `SET LOCAL app.tenant_id` per transaction;
   composite indexes start with tenant_id. A CI test fails if a tenant table
   lacks a policy.
5. IDs: UUID v7 generated client-side (needed for offline creation).
   Sync endpoints are idempotent.
6. Time: timestamptz in UTC; per-tenant timezone for business-day cutoffs.
7. No hard deletes of operational data. Audit log for price changes, discounts,
   voids, overrides and stock adjustments.
8. All UI strings go through i18n; RTL is tested; no hardcoded text in components.

## Domain rules

- Parts: internal SKU + many OEM/aftermarket numbers, quality grade
  (OEM / premium / good / economy), supplier part numbers, fitment to vehicles
  (shared vehicle hierarchy), interchange and supersession.
- Offline POS: cash sales allowed offline; orders/payments are append-only;
  negative stock allowed per tenant setting with a "needs review" flag;
  offline credit sales need a supervisor approval, logged for review.
- Mixed-currency payment (pay in currency A, change in currency B) must be
  supported inside a single order.
- Discounts need a discount grant (scope: product/percent/qty/expiry/one-time)
  or a supervisor PIN. Every discount line references its grant.
  Daily discount cap per cashier.
- Credit: limit stored in the functional currency; warn at 80% and on exceed;
  blocking is configurable per customer class.
- Costing: AVCO in the functional currency; landed costs allocated on receipt.

## Out of scope for v1

Manufacturing, full HR/payroll (payroll-lite comes later), e-commerce storefront,
marketing CRM, VIN decoding, e-invoicing connectors.

## How to work here

- Start every sprint in plan mode: propose, wait for approval, then implement.
- Tests first for: ledger posting rules, FX/rounding, stock costing,
  RLS isolation, sync idempotency.
- Record significant decisions as short ADRs: docs/adr/NNNN-title.md.
- Small commits. Run lint, typecheck and tests before saying a task is done.
- Do not invent requirements, tax rates or currency rules. Ask.
- Do not weaken an invariant above without explicit approval.
- Talk to me in Arabic. Code, comments, commits and docs in English.

## Commands

- Setup: `pnpm install`, `cp .env.example .env`, `pnpm db:up`, `pnpm db:migrate`
- `pnpm dev` | `pnpm build`
- `pnpm lint` | `pnpm format:check` | `pnpm typecheck`
- `pnpm test` = `pnpm test:unit` + `pnpm test:db` (needs PostgreSQL; recreates autoparts_test)
- `pnpm db:migrate` | `pnpm db:new <name>` | `pnpm db:codegen` (run after every migration, commit the output)
