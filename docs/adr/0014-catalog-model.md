# 0014. Catalog model

- Status: Accepted
- Date: 2026-10-04

## Context

BRIEF domain rules: a part has an internal SKU, many OEM and aftermarket numbers, an
optional quality grade (OEM / premium / good / economy), fitment to vehicles,
interchange and supersession. The pilot shop's stock sheet showed what real data looks
like:

- The same part number appears on several rows. For example, N70 batteries of
  different makes share one number.
- Vehicle codes are free text.
- Many rows have no grade or no price.

## Decision

- **Parts** (`parts`):
  - Key: an internal `sku`, unique per tenant regardless of case. Part numbers are not
    unique, so they cannot be the key.
  - At least one of `name_ar` and `name_en` is required.
  - `quality_grade` is nullable. NULL means "not graded yet": the part appears in the
    "needs review" list and ranks last in search. Grades are never guessed.
  - `unit` defaults to `piece`.
  - Parts are archived, never deleted.
  - `sku_norm` is a generated column: the SKU in part-number form.
- **Numbers** (`part_numbers`):
  - Each row stores the number as entered, a generated `number_norm`
    (`normalize_part_number`: Arabic-Indic digits to ASCII, upper case, no spaces or
    `-./_\`), a kind (`oem`, `aftermarket`, `other`) and an optional brand.
  - A number is unique only per part. Parts that share an OEM number are offered as
    alternatives to each other.
- **Fitment** (`fitments`): a part fits a vehicle node at any level. A part fitted to a
  model fits all of that model's generations and engines.
- **Interchange** (`interchange_groups` and `interchange_members`): explicit groups.
  Linking two parts that are already in different groups merges the groups, so the
  relation stays transitive.
- **Supersession** (`supersessions`): old part to new part, with a date and a reason.
  - A trigger rejects cycles.
  - Superseding copies the old part's active fitments to the new part (scenario 7).
  - Moving stock between the two parts comes with inventory (Sprint 4).
- **Links are soft-removed**: numbers, fitments, aliases, interchange memberships and
  supersessions get a `removed_at`, never a DELETE (invariant 7). Every change is
  audited.
- **Prices**:
  - **Lists** (`price_lists`): each list has one tenant currency. A currency has at
    most one active default list; making a list the default demotes the previous one.
  - **History** (`part_prices`) is append-only: no UPDATE grant, plus a
    `forbid_mutation` trigger.
  - **Current price**: the latest row whose `effective_at` has passed.
  - **Validation**:
    - The scale must not exceed the currency's minor units, checked by a trigger and by
      the API. Prices are never rounded silently.
    - Negative prices are rejected.
    - A change may be scheduled for the future but not back-dated, so the history shows
      what was in effect when.
  - **Audit**: each change is also written to `audit_log` as `price.set`, with the
    previous price.
  - **Out of scope here**: price tiers per customer class (Plus) come later.
- **Vehicle aliases** (`vehicle_aliases`): a tenant's words for vehicles ("LC",
  "لاندكروزر"). An alias targets a vehicle, a category (e.g. "MF" means batteries) or
  is ignored. Aliases serve both import mapping and search.
- **Permissions**: `catalog.manage`, `catalog.import` and `prices.manage`. Any signed-in
  user may read and search the catalog. The migration grants the new permissions to the
  existing system owner roles only. Shops decide who else gets them.

## Alternatives considered

- **Part number as the key**: rejected by the data (duplicates are real and meaningful).
- **Interchange as pairwise links**: lookups must then walk the graph, and links can
  contradict each other. Groups are simpler to query and to show.
- **Mutable `price` column on parts**: loses history and breaks invariant 7. One list
  per currency also keeps mixed-currency selling explicit.
- **Defaulting the grade**: would rank unknown-quality parts as if they were known.

## Consequences

- Search can treat "same OEM number", "same interchange group" and "replacement" as
  three alternative relations with a fixed order of strength.
- Import (ADR 0016) creates parts with generated SKUs and leaves grade NULL unless the
  file has one.
- Stock, cost and opening balances attach to `parts.id` in Sprint 4.
