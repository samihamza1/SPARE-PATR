# 0013. Shared vehicle tree: shared tables under row-level security

- Status: Accepted
- Date: 2026-10-04

## Context

Parts fit vehicles (BRIEF: "fitment to vehicles (shared vehicle hierarchy)"). Every shop
sells for the same Toyotas and Hyundais, so maintaining one vehicle tree per tenant
would repeat the same data in every shop. Shops still need to add vehicles the shared
tree lacks, without waiting for the operator. Decided in the Sprint 3 plan: one tree
shared by all tenants, plus private additions per tenant.

ADR 0006 covers tenant tables only. A shared table needs its own rules, or the RLS guard
would either reject it or let it through unchecked.

## Decision

- **One table, two kinds of rows** (`vehicles`):
  - `tenant_id IS NULL` is a platform row, curated by the operator and visible to every
    tenant.
  - `tenant_id = X` is a local addition, visible to tenant X only.
- **Tree**: `parent_id` with the levels type > make > model > generation > engine.
  A trigger (`validate_vehicle`) requires the parent to be visible and exactly one level
  up. A platform row can only have a platform parent. Years belong to generations and
  engines; engine fields belong to engines.
- **Policies**, all for named roles (no `public` policy):
  - `shared_read` (app role, SELECT): platform rows or own rows.
  - `tenant_insert` and `tenant_update` (app role): own rows only. UPDATE is granted on
    descriptive columns only, so a tenant cannot move a row to the platform or to
    another tenant.
  - `platform_curation` (owner role): all rows. Operator tooling uses the owner role.
  - No DELETE grant. Rows are archived (invariant 7).
- **References from tenant tables** (`fitments.vehicle_id`, `vehicle_aliases.vehicle_id`)
  cannot use the composite `(tenant_id, id)` foreign key of ADR 0006, because platform
  rows have no tenant. They use a plain foreign key on `id`, plus the trigger
  `check_visible_vehicle()`. Foreign-key checks bypass RLS, so the trigger is what stops
  tenant A from pointing at tenant B's local row.
- **Guard** (`db/test/rls-catalog.test.ts`): tables listed in `SHARED_TABLES` skip the
  tenant-table checks and get their own instead:
  - RLS enabled and forced.
  - Every app-role policy limits rows to platform or own.
  - Every app-role write policy is limited to own rows.
  - Only the owner role has an unrestricted policy.
  - Every foreign key from a tenant table into a shared table has a visibility trigger.

  Each check has a self-test that proves it fails on a bad probe.

- **Promotion** of a useful local row to the platform tree is an operator action,
  done with the owner role (a CLI first; a UI later).

## Alternatives considered

- **Per-tenant trees**: simple RLS, but every shop re-enters the same makes and models,
  and the operator cannot improve the data once for everyone.
- **Platform-only tree**: shops would wait for the operator before selling a part for a
  rare vehicle.
- **A separate global table plus a tenant table**: two tables to join and search, and
  two foreign keys on every fitment.

## Consequences

- Search and the fitment picker read one table.
- Any future shared table (e.g. a shared brand list) must be added to `SHARED_TABLES`
  and follow the same policy and trigger pattern, or CI fails.
- Sibling names are unique per owner (platform or one tenant). A tenant may therefore
  add a local "Hilux" next to a platform "Hilux"; promotion has to merge such pairs.
- Platform data quality is an operator responsibility. No vehicle data is seeded in the
  repository; the tree grows from import mappings and operator curation.
