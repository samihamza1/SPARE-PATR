# 0024. Opening stock from an imported sheet

- Status: Accepted
- Date: 2026-10-07

## Context

Shops start with their stock in the same spreadsheet as their catalog. The catalog import
(ADR 0016) keeps each row's quantity and cost and links the row to its part. The pilot's
sheet repeats some parts, has rows without a cost or with a cost of zero, a few non-whole
quantities, and costs in AED while the functional currency is USD. The product owner
decided (2026-10-06):

- repeated rows are combined by summing their quantities;
- a row with a quantity but no cost, or a cost of zero, needs a cost entered before posting;
- quantities come from the file, and a physical count corrects them later;
- costs in another currency convert at the rate of the go-live day.

## Decision

- **A draft per applied import batch** (`opening_stock_drafts`, one live draft per batch),
  with one line per part (`opening_stock_lines`), built from the batch's rows that have a
  part and were not skipped:
  - quantities are summed; a sum that is not whole units leaves the line "needs quantity";
    a sum of zero excludes it;
  - when every row with a quantity has a positive cost, the line keeps the exact total
    Σ quantity × unit cost (`file_cost_total`, not rounded) and its amount is that total
    rounded once to the cost currency; the weighted average is never rounded;
  - otherwise the line "needs cost" and offers the average of the rows that had one;
  - a part that already has opening stock at the draft's location is excluded.
- **Line states**: ready, needs cost, needs quantity, excluded (generated column). The
  owner enters a unit cost, changes a quantity or excludes a line. A changed quantity of a
  file-costed line scales the file total exactly (one division, one rounding).
- **Settings**: location (default shop), as-of date (not in the future) and the rate:
  the one chosen, else the rate in effect on the as-of date (ADR 0019).
- **Posting** (`stock.opening` and `cost.view`):
  - refused while any line needs a cost or a quantity (`opening.not_ready`);
  - one `opening` document whose id is the draft's id, with one move per ready line,
    each valued and converted on its own; posting again returns the same document;
  - the database allows one `opening` move per part and location (unique index).
- Import rows of an applied batch are frozen (ADR 0020), so the draft always reads what
  was applied.

## Alternatives considered

- **Averaging repeated rows' quantities or taking the first row**: the product owner chose
  summing.
- **Using the file's USD column**: it is a rate the shop applied once; the recorded go-live
  rate keeps invariant 2 traceable.
- **Posting rows without cost at zero**: understates stock value and cost of sales.

## Consequences

- The draft's totals in both currencies equal the posted moves to the cent (tested).
- After posting, differences found on the shelf go through a count (ADR 0025).
