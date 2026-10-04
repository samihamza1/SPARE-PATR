# 0006. Tenancy: RLS, database roles and the CI guard

- Status: Accepted
- Date: 2026-10-04

## Context

Invariant 4 requires tenant isolation enforced by PostgreSQL Row-Level Security with
FORCE, an app role without BYPASSRLS, `SET LOCAL app.tenant_id` per transaction,
tenant-first indexes and a CI test that fails if a tenant table lacks a policy.

## Decision

**Roles** (created by `pnpm db:bootstrap`, not by migrations):

- `autoparts_owner` owns the schema and runs migrations. NOSUPERUSER, NOBYPASSRLS;
  because RLS is FORCEd it is subject to policies too.
- `autoparts_app` is the runtime role. NOSUPERUSER, NOBYPASSRLS, owns nothing, no
  CREATE on the schema, never DELETE or TRUNCATE (no hard deletes, invariant 7);
  append-only tables also lack UPDATE.

**Tenant context**: `current_tenant_id()` reads `app.tenant_id` and returns NULL
when unset, so every policy matches nothing (fail closed). A malformed value raises
an error. The API sets it only through `withTenant` (transaction-local).

**Table conventions** (enforced by `findTenancyViolations`, run in CI):

- every table either has `tenant_id` or is listed in `GLOBAL_TABLES`;
- tenant tables: RLS enabled and forced, a `FOR ALL` policy whose USING and
  WITH CHECK both compare to `current_tenant_id()`, and no permissive policy that
  does not (permissive policies are OR-ed);
- every index on a tenant table starts with `tenant_id`; primary keys are
  `(tenant_id, id)`;
- foreign keys between tenant tables include `tenant_id`, so a row cannot reference
  another tenant's row even though FK checks bypass RLS;
- views must use `security_invoker = true`.

The guard test also self-tests each failure mode in a rolled-back transaction.

**Users** belong to exactly one tenant for now (default accepted in the Sprint 1
plan). Login before the tenant is known is a later design question; it may need a
narrow SECURITY DEFINER lookup or a global identity table, recorded in a new ADR.

**Tenants** are provisioned by the owner role with `app.tenant_id` set to the new
tenant id. The app role can read its tenant and update only `name` and
`default_locale`; changing functional currency or timezone needs a dedicated,
audited procedure.

## Consequences

- A forgotten policy, a loose policy, a wrong index or an unscoped FK fails CI.
- Every query must run inside `withTenant`; queries outside it see no rows.
- Cross-tenant administration (support tooling, reporting) needs an explicit,
  separate path; it is not possible through the app role.

## Alternatives considered

- Schema-per-tenant or database-per-tenant: stronger physical isolation but heavy
  migration and connection overhead for many small shops.
- Application-only filtering (`WHERE tenant_id = ?`): one missed clause leaks data.
