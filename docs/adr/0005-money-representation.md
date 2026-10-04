# 0005. Money representation: decimal.js, decimal strings, configured currencies

- Status: Accepted
- Date: 2026-10-04

## Context

Invariant 1 forbids JS floats for money and FX rates. Invariant 2 requires every amount
to carry its currency, the FX rate used and the functional-currency equivalent. The
pilot tenant's currencies and rounding rules are not decided, so nothing currency-specific
may be hardcoded. Allocation (landed costs, discounts) must never lose or invent a cent.

## Decision

- **decimal.js**, as an isolated clone (`precision: 64`, exponent notation disabled).
  The global decimal.js config is never touched.
- **Wire format**: decimal strings matching `^-?(0|[1-9]\d*)(\.\d+)?$`, never numbers or
  exponents. `dec()` rejects JS numbers at runtime too. In Postgres: `NUMERIC`
  (node-postgres already returns it as a string).
- **No currency table in code.** Callers pass a `CurrencySpec { code, minorUnits,
cashIncrement? }` loaded from tenant configuration. The rounding mode is always an
  explicit argument (`HALF_UP | HALF_DOWN | HALF_EVEN | UP | DOWN | CEIL | FLOOR`).
- **FX rate convention**: units of the target currency per 1 unit of the source.
  Rates are stored unrounded. Converted amounts are rounded to the target minor units.
- `toFunctional()` returns the full invariant-2 record
  `{ amount, currency, fxRate, functionalAmount }`.
- Cash rounding (`roundToIncrement`) and `allocate` (largest remainder, ties to the
  earliest index) use exact bigint arithmetic. Allocation parts always sum to the total.
- Property-based tests (fast-check) cover:
  - rounding: idempotence, error bounds, direction, ties, symmetry, and agreement
    between the two rounding implementations;
  - arithmetic exactness;
  - conversion: monotonicity and error bounds;
  - allocation: sum and fairness.

## Alternatives considered

- **big.js**: smaller, but only four rounding modes and no `CEIL`/`FLOOR`.
- **dinero.js**: models money as integer minor units. That fits amounts but not FX
  rates or intermediate quantities × prices, and it bakes in currency definitions.
- **Integer minor units in code**: same problem with rates and per-tenant precision.

## Consequences

- Money code reads as `add(a, b)` rather than `a + b`; lint rules ban the float escape
  hatches (`parseFloat`, `Number()`, unary `+`, `Math.round`) in money and DB code.
- Tenant settings must supply a `CurrencySpec` and a rounding mode for each use (sales
  lines, tax, cash, FX). Those choices are open questions for the pilot tenant.
