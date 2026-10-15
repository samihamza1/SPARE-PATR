# 0003. Query layer: Kysely with types generated from the database

- Status: Accepted
- Date: 2026-10-04

## Context

PostgreSQL is the source of truth and the schema is written as SQL migrations (invariants,
RLS policies, triggers and deferred constraints are all SQL). We want type-safe queries
without a second, hand-maintained copy of the schema. We need explicit transactions:
every tenant-scoped unit of work starts with `SET LOCAL app.tenant_id`.

## Decision

- **Kysely** as a type-safe query builder over `pg` (node-postgres).
- **kysely-codegen** generates `db/src/types.generated.ts` from a migrated database
  (`pnpm db:codegen`). CI fails if the committed file differs from the schema
  (`codegen:check`).
- Column names stay `snake_case`, as in SQL. No camel-case plugin and no mapping layer.
- NUMERIC stays a string end to end (the node-postgres default; a test pins it).
- Tenant-scoped access goes through `withTenant(db, tenantId, fn)`.

## Alternatives considered

- **Drizzle**: its schema is defined in TypeScript and its migrations are generated from
  that. With SQL-first migrations we would maintain both, or rely on `drizzle-kit pull`
  as a second generator. RLS policies, triggers and deferred constraint triggers are
  first-class in SQL but secondary in Drizzle's schema DSL.
- **Prisma**: its own schema language, weak support for RLS/`SET LOCAL` patterns, and a
  heavier runtime.
- **Raw `pg` + hand-written types**: no compile-time safety for column names or result shapes.

## Consequences

- One source of truth (SQL). Types follow it automatically.
- Developers need a migrated local database to regenerate types after a migration.
- Complex SQL can drop to Kysely's `sql` template without leaving the type system.
