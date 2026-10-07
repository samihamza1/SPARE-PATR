# 0010. Tenant settings

- Status: Accepted
- Date: 2026-10-04

## Context

CLAUDE.md forbids hardcoding currency, tax or country rules: they are per-tenant
configuration. Some settings have agreed defaults (session and lockout limits); others
are business rules the BRIEF leaves to each shop (rounding, negative stock) and must not
get a silent default.

## Decision

- Settings live in `tenants.settings jsonb`, validated by one zod schema
  (`tenantSettingsSchema` in `packages/shared`) on every write and read.
- Two kinds of field:
  - **defaulted**: `session.idleMinutes` (30), `session.absoluteHours` (12),
    `security.maxFailedLogins` (5), `security.lockoutMinutes` (15);
  - **required, no default**: `money.roundingMode`, `inventory.allowNegativeStock`.
    Provisioning fails without them.
- If stored settings do not validate, `GET /settings` returns `settings: null` so the UI
  can force setup, and authentication falls back to the session/security defaults.
- **Currencies** are rows in `tenant_currencies` (code, minor units, optional cash
  increment, active flag), not settings: other tables will reference them. The
  functional currency must exist and stay active (deferred constraint trigger). Code
  and minor units cannot change once created; nothing is seeded.
- Functional currency and time zone live on `tenants` and are not editable through the
  app (ADR 0008).
- Every change is audited as `settings.change` / `currency.*` with before and after.

## Alternatives considered

- **One column per setting**: stronger typing in SQL, but a migration for every new
  knob; jsonb plus zod gives the same validation at the boundary.
- **Key/value rows**: harder to validate as a whole and to audit as one change.

## Consequences

- New modules add their settings to the schema; a new required field needs a data
  migration or a setup step for existing tenants.
- The database does not validate the jsonb shape; only the API writes it.

## Addendum (2026-10-07, Sprints 1–3 review)

- A cash increment must be above zero. It is stored as its value ("0.050" is 0.05).
- An increment finer than the currency's minor units is refused with a field-level issue
  (`currency.cash_increment_scale`) instead of a bare database error.
