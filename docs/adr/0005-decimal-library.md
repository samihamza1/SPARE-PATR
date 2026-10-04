# 0005. Decimal library: decimal.js behind a string API

- Status: Accepted
- Date: 2026-10-04

## Context

Invariant 1 forbids JS floats for money and FX rates. We need exact addition and
multiplication, explicit rounding modes (the mode is a per-tenant decision), cash
rounding to an increment, proportional allocation without losing minor units, and
FX conversion in either rate direction. The first customer's currencies are not
decided, so nothing may assume a currency.

## Decision

- Use **decimal.js** internally (isolated clone, precision 1000, exponent notation
  disabled). It never leaves `packages/shared/src/money`.
- The public API works on `DecimalString` (a branded, validated string such as
  `"-12.50"`). `parseDecimal` rejects JS numbers, exponents, whitespace, `+`, `.5`
  and inputs over 100 digits.
- No currency table and no default rounding: callers pass a `CurrencySpec`
  (`code`, `minorUnits`, optional `cashIncrement`) from tenant configuration and a
  `RoundingMode` (`HALF_UP`, `HALF_DOWN`, `HALF_EVEN`, `UP`, `DOWN`).
- `money()` refuses amounts with more decimals than the currency allows: rounding
  is always an explicit call.
- `FxRate { base, quote, rate }` means 1 base = rate quote. `MonetaryAmount` stores
  amount, currency, the rate object used (with direction) and the functional amount
  (invariant 2).
- Property-based tests compare against an independent BigInt oracle, with a
  dedicated generator for exact ties.

## Consequences

- Add/sub/mul are exact for all accepted inputs; division always takes an explicit
  scale and rounding mode.
- Slightly more verbose call sites than float arithmetic; this is intended.

## Alternatives considered

- **big.js**: smaller, but only four rounding modes (no HALF_DOWN) and fewer
  helpers.
- **dinero.js**: integer minor units with a currency table built in; its currency
  data and API shape would leak assumptions we must keep in configuration.
- Native `BigInt` scaled integers: exact, but we would re-implement division,
  rounding modes and parsing ourselves.
