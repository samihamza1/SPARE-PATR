# Sky Motors onboarding (pilot)

Run this once hosting is chosen and the production database exists. Nothing here
creates data by itself.

## Decisions

| Setting                | Value                                    | Source                                  |
| ---------------------- | ---------------------------------------- | --------------------------------------- |
| Functional currency    | USD, 2 decimal places                    | Product owner, Sprint 3 plan            |
| Other currencies       | SSP and AED, 2 decimal places each       | Product owner; places per ISO 4217      |
| Time zone              | Africa/Juba                              | Sprint 3 plan                           |
| Default language       | Arabic                                   | BRIEF                                   |
| Rounding               | HALF_UP (nearest, halves up)             | Product owner delegated, 2026-10-05 (1) |
| Negative stock         | Not allowed                              | Product owner, 2026-10-05               |
| Zero prices in imports | Imported as 0, flagged in the preview    | Product owner, 2026-10-05               |
| Cash increments        | Not decided; optional, set in Settings   | Open                                    |
| Default USD sell list  | "USD /JUBA" column of the stock workbook | Sprint 3 plan assumption                |

(1) HALF_UP is the usual commercial rounding on receipts. It can be changed later in
Settings → Business rules.

## Steps

1. Migrate the database: `pnpm db:migrate`.
2. Create the shop (the owner password is asked for, hidden):

   ```sh
   pnpm tenant:create --slug sky-motors --name "Sky Motors" --timezone Africa/Juba \
     --locale ar --currency USD --minor-units 2 --rounding HALF_UP \
     --negative-stock deny --owner-username <owner username> --owner-name "<owner name>"
   ```

3. Sign in to the back office as the owner.
   1. Go to Settings → Currencies and add SSP (2 places) and AED (2 places).
   2. Go to Catalog setup → Price lists and add "USD /JUBA" in USD as the default list.
   3. Add the categories that vehicle codes will point to, e.g. Batteries for "MF".
4. Go to Import catalog and upload the stock workbook. It stays on the shop's computer
   and is never committed to the repository.
   1. Sheet: `LAND`. Header row: 3.
   2. Map the columns:

      | Column        | Field         | Note                                                                |
      | ------------- | ------------- | ------------------------------------------------------------------- |
      | B (Column2)   | Part number   |                                                                     |
      | C (P/NAME)    | English name  |                                                                     |
      | D (P/Name)    | Arabic name   |                                                                     |
      | E (Column1)   | Vehicle code  |                                                                     |
      | F (USD /JUBA) | Selling price | Into "USD /JUBA"                                                    |
      | H (Rate AR.D) | Cost          | Currency: AED                                                       |
      | I (Qnty)      | Quantity      | Kept for the opening-stock step                                     |
      | G (Rate:USD)  | (not mapped)  | Computed from AED; the exchange rate is recorded with opening stock |

   3. Answer "The part numbers are" with the shop. Most are Toyota OEM numbers.
   4. SKU prefix: e.g. `SKY`.
5. Map the vehicle codes with the shop, then refresh the preview and apply.
   - Codes that are not vehicles (e.g. "MF") map to a category or are ignored.
   - The code "0" (about 19 rows) needs the shop's explanation.
6. Grade the parts from Parts → "No quality grade", using bulk edit.

## What to expect (local dry run, 2026-10-05)

A dry run with placeholder settings on a local database only gave the following:

- **Rows staged:** 2,251, in 0.5 s.
- **Apply:** 2,237 parts and 2,140 prices, in 0.6 s.
- **Repeated rows:** 13, merged into the first occurrence; 6 of them had a different
  price.
- **Rows sharing a number with a different part:** 322. They are kept as separate parts
  and shown as alternatives.
- **Gaps:** 24 rows without a part number, 83 without a price, 14 with a price of zero.
- **Skipped:** 1 footer row (price "-", no name).
- **Vehicle codes:** 51 distinct after normalisation. The most frequent are LC (978
  rows), 2KD (309), V8 (245), PRADO (191) and GXR (109).

These counts will differ slightly with the final settings, because zero prices are now
imported.
