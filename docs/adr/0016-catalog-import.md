# 0016. Catalog import from spreadsheets

- Status: Accepted
- Date: 2026-10-05

## Context

Shops arrive with their catalog and stock in spreadsheets. The pilot shop's workbook
has 23 sheets. The catalog is one of them, with 2,256 rows. The others hold personal
and family entries, debts and daily sales. The catalog sheet itself has:

- a title row above the header row;
- free-text vehicle codes ("LC", "lc", "HILUX2018", "2KD", "MF");
- repeated part numbers, and rows without a number or a price;
- whitespace-only cells;
- binary float artefacts such as `17.850000000000001`.

The import must turn such a sheet into parts without guessing, without storing what is
not needed, and without duplicating anything when it runs again. Quantities and costs
are needed later, for opening stock (Sprint 4).

## Decision

- **Library**: `read-excel-file`. It is maintained (9.x, 2026) and MIT-licensed, and it
  reads stored cell values (formulas are not evaluated). Its `parseNumber` option returns
  each numeric cell's stored text, so values never pass through a JS float (invariant 1).
  - **Number cleaning**: numeric text is cut to 15 significant digits, the precision Excel
    itself works with, so `17.850000000000001` becomes `17.85`.
  - **CSV**: UTF-8 CSV is read by a small RFC 4180 reader.
  - **Rejected input**: legacy `.xls` and other files get `import.unreadable_file`.
  - **Limits**: file size 10 MB; the zip's declared uncompressed size must not exceed
    200 MB; at most 20,000 rows per sheet.
- **Privacy**:
  - The file is uploaded twice (as base64 JSON) and never stored. _Inspect_ returns
    sheet names and the first 30 rows and writes nothing.
  - _Stage_ stores, for the chosen sheet only, the **mapped columns** of the data rows
    below the chosen header row. Unmapped columns, other sheets, and rows with nothing in
    the mapped columns are dropped. Only the file name and its SHA-256 are kept.
  - Costs are shown only to users with `cost.view`.
- **Mapping** (chosen by the user; nothing is guessed):
  - Columns for SKU, part number, English and Arabic names, vehicle code, selling price,
    cost and quantity.
  - What the part numbers are (`oem`, `aftermarket` or `other`).
  - The price list for selling prices.
  - The currency of the cost column.
  - An SKU prefix for generated SKUs (`PREFIX-00001`, continuing after the highest
    existing one).
- **Vehicle codes** are mapped through the tenant's vehicle aliases (ADR 0014). Each
  code maps to one or more vehicles, to a category (e.g. "MF" means batteries), or is
  ignored. Codes are grouped by their normalised form, so "LC" and "lc" are mapped once,
  and the mapping is reused by later imports and by search.
- **Numbers in cells**:
  - Text such as "1,200" is refused (`bad_price`) rather than read as 1200 or 1.2.
    Arabic-Indic digits are accepted.
  - Selling prices are rounded to the list currency's minor units with the tenant's
    rounding mode. A row whose price changed is flagged `price_rounded`.
  - A price of zero is imported as given and flagged `zero_price` in the preview, so it
    can be reviewed (product owner's decision, 2026-10-05).
  - Cost and quantity are kept as read.
- **Row identity** is the normalised part number, name and vehicle code.
  - **Repeats in one file** are merged into the first occurrence (`merge`). If the
    prices differ, the row is flagged `price_conflict` and the first price is used.
  - **Same number, different identity**: the rows become separate parts, flagged
    `shared_number`. With OEM numbers they show as alternatives.
  - **Identity from an earlier applied import**: the row updates that part (`update`).
    Only a changed price is appended; missing vehicle links are added.
  - **Blocking issues** skip the row: no name, an empty row, an invalid or already used
    SKU. The user may also skip any row.
- **Apply**:
  - Runs in one transaction, which re-analyses the rows first.
  - Creates parts, numbers, fitments and categories (from aliases), and prices
    (`source = 'import'`, linked to the batch).
  - Links each row to its part, so Sprint 4 can read quantities and costs.
  - Writes one `catalog.import` audit entry with the counts.
- **Idempotency**: a sheet of a file (same SHA-256) can be applied once. This is enforced
  by a unique index on applied batches and by a check that runs before staging and inside
  apply. A batch applies at most once. Other batches can be discarded, never deleted.

## Alternatives considered

- **SheetJS (`xlsx` on npm)**: the npm release is outdated and has known vulnerabilities;
  current releases are distributed outside npm. **ExcelJS**: unmaintained since 2024.
- **Storing the uploaded file** for later steps: simpler, but it would keep sheets the
  shop never meant to share (personal entries, debts).
- **Part number as the identity**: duplicates are real (e.g. batteries sharing "N70"),
  so it would merge different products.
- **Guessing grades, vehicles or number kinds** from names: wrong guesses are hard to
  spot later. The "needs review" lists make the gaps visible instead.

## Consequences

- A typical sheet (2,251 rows) stages in about 0.5 s and applies in about 0.6 s on the
  development container.
- Opening stock (Sprint 4) reads `import_rows.parsed.quantity` and `cost` for rows with
  a `part_id`. The cost currency is in the batch mapping. The FX rate and the
  functional-currency amount (invariant 2) are recorded then, not now.
- Parts created by an import start ungraded. Grading uses the parts list's
  "no quality grade" filter and bulk edit.
- Real customer files are imported only into a local or production database, never
  into the repository. Tests use synthetic sheets built in memory.
