# 0006. Tenant isolation with Postgres row-level security

- Status: Accepted
- Date: 2026-10-04

## Context

Invariant 4 requires `tenant_id` on every tenant table, RLS with FORCE, an app role
without BYPASSRLS, `SET LOCAL app.tenant_id` per transaction, composite indexes starting
with `tenant_id`, and a CI test that fails when a tenant table lacks a policy. This ADR
records how those rules are implemented, so later work does not erode them.

## Decision

- **Roles** (`db/bootstrap/00-roles.sh`):
  - `autoparts_owner` owns the schema and runs migrations. It is not a superuser and has
    no BYPASSRLS, so FORCE RLS applies to it too.
  - `autoparts_app` is used at runtime. It has NOBYPASSRLS, owns nothing, and holds only
    the privileges each migration grants explicitly.
  - Superusers bypass RLS and are used for bootstrap only.
- **Tenant context**: `withTenant(db, tenantId, fn)` opens a transaction and runs
  `set_config('app.tenant_id', $1, true)` (`SET LOCAL`). `current_tenant_id()` reads it
  with `NULLIF(..., '')`, because after a `SET LOCAL` ends the setting reads `''`, not
  NULL. No tenant means NULL means no rows (fail closed).
- **Policy shape**: one permissive `FOR ALL` policy per table,
  `USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`
  (`id = current_tenant_id()` on `tenants`).
- **Cross-tenant references are impossible by construction**: each referenced table has
  `UNIQUE (tenant_id, id)`, and foreign keys are composite `(tenant_id, x_id)`.
- **Users belong to exactly one tenant** (decided 2026-10-04). Login therefore identifies
  the tenant first (e.g. shop code plus username). A global identity table can be added
  later if one person must work for several tenants.
- **Privileges**:
  - The app role gets no DELETE on any table (invariant 7: archive or revoke instead).
  - Append-only tables (today `audit_log`; later journals and stock moves) get no UPDATE.
    A `forbid_mutation()` trigger also rejects UPDATE/DELETE/TRUNCATE from any role.
  - Tenants are created by the owner role only, until onboarding is designed.
- **Catalog test** (`db/test/rls-catalog.test.ts`) fails CI unless every table is either
  tenant-scoped (RLS enabled and forced, a tenant policy, no permissive policy that skips
  the tenant, multi-column indexes leading with `tenant_id`) or listed in `GLOBAL_TABLES`.
  It also checks role attributes, DELETE/TRUNCATE/UPDATE privileges and the append-only
  triggers.

## Alternatives considered

- **Schema or database per tenant**: stronger physical isolation, but migrations and
  cross-tenant operations (platform admin, analytics) multiply with tenant count.
- **Application-level filtering only**: one missing `WHERE tenant_id = ...` leaks data.
  RLS makes the database enforce it.
- **Passing the tenant as a session `SET`**: survives the transaction and leaks across
  pooled connections. `SET LOCAL` is scoped to the transaction.

## Consequences

- Every tenant-scoped query must run inside `withTenant`; outside it, queries see nothing.
- Pre-tenant lookups (e.g. resolving a shop code at login) will need a narrow
  `SECURITY DEFINER` function, reviewed like any other policy exception.
- Adding a table means adding its policy and grants in the same migration, or CI fails.

## Addendum (2026-10-07, Sprints 1–3 review)

The catalog guard (`db/test/rls-catalog.test.ts`) is stricter:

- A policy must use the tenant predicate exactly. Text that merely mentions
  `current_tenant_id()` is not enough.
- `tenant_id` must be NOT NULL outside the shared tables.
- A reference into a shared table needs a visibility trigger on INSERT and UPDATE of that
  column.
- Append-only tables are found from their `forbid_mutation` triggers, with a required
  list.
- Each check has a self-test that makes it fail.
