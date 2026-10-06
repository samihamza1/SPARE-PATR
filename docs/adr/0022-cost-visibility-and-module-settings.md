# 0022. Cost visibility and per-module settings

- Status: Accepted
- Date: 2026-10-06

## Context

The BRIEF says cashiers sell but cannot see cost or margin, while they do see quantities
in every location (product owner, 2026-10-06). Stock values now appear in stock reads,
moves and audit entries. Separately, the catalog import read the whole tenant settings
object and failed if any unrelated part was missing or invalid.

## Decision

- **Values travel under a `cost` key** that the API fills only for users with `cost.view`:
  - `GET /stock/parts/:id` adds `cost` (value and average) only then;
  - `GET /stock/moves` adds the invariant-2 fields under `cost` only then;
  - import rows already drop `cost` without it (ADR 0016);
  - `GET /audit-log` drops `cost` from `before` and `after` snapshots for users without
    it, so audit entries of stock documents keep values under that key.
- **Quantities need only a session**: stock reads, locations and search quantities.
- **Settings are read per module**: `readMoneySettings` (functional currency, minor units,
  rounding mode, time zone) and `readInventorySettings` (negative stock). A business rule
  that was never chosen is a 409 `settings.incomplete`, never a default (CLAUDE.md: no
  invented rules). The shared schemas `moneySettingsSchema` and `inventorySettingsSchema`
  are the single definition used by provisioning, settings and the readers.

## Alternatives considered

- **Separate endpoints for cost**: doubles the API and is easy to forget on new screens.
- **Defaults for missing settings**: would silently decide money and stock rules.

## Consequences

- New endpoints that return values must use the `cost` key and the `seesCost` helper.
- The import service moves to `readMoneySettings`.
