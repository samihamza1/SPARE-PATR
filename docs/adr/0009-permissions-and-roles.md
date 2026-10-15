# 0009. Permissions and roles

- Status: Accepted
- Date: 2026-10-04

## Context

The BRIEF lists configurable roles: Cashier (sells, cannot see cost or margin),
Supervisor (all transactions, grants discounts, approves returns), Owner/Admin and an
optional Accountant. Most of the permissions those roles need belong to modules that do
not exist yet (sales, inventory, ledger).

## Decision

- **Permission codes live in code** (`packages/shared/src/auth/permissions.ts`) and are
  stored on `roles.permissions text[]`. Unknown codes read from the database are dropped,
  never trusted. Labels are i18n keys.
- Platform permissions now: `users.manage`, `roles.manage`, `settings.manage`,
  `devices.manage`, `sessions.manage`, `audit.read`, and `cost.view` (the BRIEF's
  cashier restriction). Each module adds its own codes when it lands.
- **System role templates** are copied into each tenant at provisioning: owner (all),
  supervisor (`audit.read`, `sessions.manage`, `cost.view`), accountant (`audit.read`,
  `cost.view`), cashier (none yet). Tenants may edit them and create their own roles.
- Effective permissions are the union over the user's active grants, re-read on every
  request.
- **Lock-out guard**: a change that would leave no active user holding a role with both
  `users.manage` and `roles.manage` is refused (`users.last_admin`). Users cannot
  archive themselves.
- Grants are revoked (`revoked_at/by`), never deleted; every grant, revoke and role
  change is audited with before/after.

## Alternatives considered

- **Permission rows in a table**: allows per-tenant custom permissions, which nothing
  needs; code-defined codes keep the API checks and the catalog in one place.
- **Fixed roles only**: the BRIEF asks for configurable roles.

## Consequences

- Adding a permission is a code change plus, if system roles should get it, a data
  migration for existing tenants.
- The last-admin check requires both permissions on a single role; splitting them across
  roles is allowed but does not count towards the guard.
