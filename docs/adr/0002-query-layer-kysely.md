# 0002. Query layer: Kysely

- Status: Accepted
- Date: 2026-10-04

## Context

PostgreSQL is the source of truth and migrations are hand-written SQL (CLAUDE.md).
The query layer must give typed queries, explicit transactions (every tenant query
runs inside a transaction with `SET LOCAL app.tenant_id`), and must not hide SQL
needed for ledger, stock and RLS work. NUMERIC must reach the app as strings.

## Decision

Use **Kysely** with the `pg` driver.

- Types are generated from the live schema with `kysely-codegen`
  (`pnpm db:codegen` → `db/src/generated/db.ts`, committed). CI runs
  `pnpm db:codegen:verify` so generated types can never drift from migrations.
- NUMERIC is generated as `string` (codegen default, and `pg` returns NUMERIC as
  string), matching the decimal-string rule.
- `withTenant(db, tenantId, fn)` in `@autoparts/db` is the only sanctioned way to
  run tenant queries: a Kysely transaction that first calls
  `set_config('app.tenant_id', $1, true)` (the parameterised form of `SET LOCAL`).

## Consequences

- SQL stays the single source of truth; the TypeScript schema follows it.
- Queries read like SQL; raw `sql` fragments remain available for CTEs, locking,
  window functions and catalog queries.
- No ORM conveniences (relations, identity map); we write joins explicitly.

## Alternatives considered

- **Drizzle**: good types, but its schema is defined in TypeScript and its tooling
  wants to own migrations (drizzle-kit). With SQL-first migrations we would maintain
  the schema twice or fight the generator. Introspection exists but is a secondary
  path.
- Prisma: own schema language, heavier runtime, weaker control over transactions
  and session settings; NUMERIC maps to its own Decimal type.
- Plain `pg` with hand-written types: no compile-time checking of queries.
