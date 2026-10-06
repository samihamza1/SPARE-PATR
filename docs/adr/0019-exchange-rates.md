# 0019. Exchange rates

- Status: Accepted
- Date: 2026-10-06

## Context

Invariant 2 needs, for every amount, the rate used and the functional-currency amount. The
pilot shop prices in USD and holds costs in AED, and will take payments in SSP. Rates are
entered by hand, usually once a day (product owner, 2026-10-06). Traders quote them one
way ("1 USD = 3.6725 AED"); storing the inverse (0.272294077…) would need rounding, and
converting with a rounded inverse loses cents on large amounts.

## Decision

- **Table `fx_rates`**, append-only (`forbid_mutation`): base currency, quote currency,
  rate, business date, note, who recorded it and when.
  - The rate is stored **as quoted**: 1 base = rate quote, positive, at most 10 decimal
    places and 12 integer digits.
  - One side is always the tenant's functional currency (trigger); either side may be.
  - Both currencies must be tenant currencies (composite foreign keys).
  - The business date follows the tenant's time zone (invariant 6). A rate cannot be dated
    in the future; past dates are allowed (late entry).
- **The rate in effect** for a date is the latest row dated on or before it, in either
  direction of the pair; for the same date the latest recorded one wins. A correction is
  therefore a new row, and earlier documents keep the rate they used.
- **Conversion never rounds the rate**: from the base currency the amount is multiplied,
  from the quote currency it is divided exactly (`divideRounded`, bigint arithmetic), and
  the result is rounded once to the target's minor units with the tenant's rounding mode.
- **What a move stores** (invariant 2): amount and currency as entered, `fx_rate`,
  `fx_base`, `fx_quote` (so the direction is explicit), `fx_rate_id` (the recorded row)
  and the functional amount. The stock trigger checks that the rate and pair equal the
  recorded row and that amounts have their currencies' decimals.
- **Access**: everyone signed in reads rates (cashiers will take payments in several
  currencies); `fx.manage` (owner, accountant) records them. `GET /fx-rates/current`
  says, per currency, whether today's rate was entered, so the back office can warn.

## Alternatives considered

- **Storing "functional per unit" only** (the convention `MonetaryAmount.fxRate` used so
  far): forces a rounded inverse for currencies quoted the other way.
- **Fetching rates from a feed**: the pilot's markets (SSP) have no reliable feed and the
  shop sets its own rate; a feed can be added later as another source of rows.

## Consequences

- The older `convert` / `toFunctional` helpers stay for rates already expressed as
  functional-per-unit; new code uses `convertByQuote` / `toFunctionalByQuote`.
- Opening stock uses the go-live day's recorded rate (ADR 0024); sales will use the
  rate in effect on their business date.
- The functional currency cannot change once rates or stock moves exist (trigger).
