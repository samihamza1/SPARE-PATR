# 0015. Catalog search

- Status: Accepted
- Date: 2026-10-04

## Context

BRIEF scenario 1: a salesperson types something like "فحمات امامية لاندكروزر 2015"
(front brake pads, Land Cruiser 2015) or a part number in whatever form the customer
gives. The result must show:

- the matching parts and their alternatives;
- alternatives ordered by quality, then price.

Arabic text varies in spelling: alef forms, teh marbuta, Arabic-Indic digits and
diacritics. Part numbers vary in spacing and punctuation.

## Decision

- **Normalisation in one place, two implementations**:
  - `normalize_search()` and `normalize_part_number()` are IMMUTABLE SQL functions, used
    in generated columns and indexes.
  - `normalizeSearchText()` and `normalizePartNumber()` in `packages/shared` implement
    the same rules for the API and, later, the offline POS index.
  - **`normalize_search()`** unifies alef forms (أ إ آ ٱ to ا), ى to ي, ئ to ي, ؤ to و
    and ة to ه. It removes diacritics and tatweel, converts Arabic-Indic and Persian
    digits to ASCII, and lower-cases ASCII only. Punctuation becomes a space, and runs
    of spaces collapse to one.
  - **`normalize_part_number()`** converts digits, upper-cases ASCII and drops spaces
    and `-./_\`.
  - Both are built from the same character tables. A property-based test compares the
    SQL and TypeScript results on random strings drawn from the relevant alphabets.
- **Indexes**:
  - `pg_trgm` and `btree_gin` (trusted extensions, created by the owner role).
  - GIN `(tenant_id, search_text gin_trgm_ops)` on parts.
  - `(tenant_id, number_norm text_pattern_ops)` on active part numbers.
  - `(tenant_id, sku_norm text_pattern_ops)` on parts.
- **Interpreting a query** (`apps/api/src/catalog/search.ts`):
  1. Normalise the query and split it into words.
  2. **Year**: a word matching 19xx or 20xx.
  3. **Part-number candidates**: the whole query and each word in part-number form,
     when they contain a digit and have at least 4 characters. These are matched
     against numbers and SKUs, exact before prefix.
  4. **Vehicle words**: word n-grams (longest first, up to 3 words) that equal a
     tenant alias or a vehicle name (English or Arabic). Matched words are removed
     from the text.
  5. **Vehicle scope**: the matched nodes, their ancestors (a part fitted to the model
     fits each generation) and their descendants. When a year was given, only
     generations and engines whose year range covers it are kept.
  6. **Text**: every remaining word must occur in the part's `search_text`, and the
     part must fit a vehicle in scope when a vehicle was named. Results are ordered by
     `word_similarity` to the remaining words.
- **Results**:
  - Number hits come first, then text or vehicle hits.
  - Each result carries its alternatives:
    - replacement (supersession), then
    - same interchange group, then
    - shared OEM number.

    Alternatives are sorted by grade (OEM > premium > good > economy > ungraded), then
    by price ascending, then by SKU.

  - Archived parts never appear.
  - Prices come from the default list of the requested currency (default: the
    functional currency), formatted at that currency's minor units.
- **Stock**: added to results in Sprint 4 (availability per location).

## Alternatives considered

- **PostgreSQL full-text search** (`tsvector`): its Arabic stemming is not designed for
  part names, and it does not match partial part numbers. Trigrams handle typos and
  substrings in both languages.
- **An external search engine** (OpenSearch, Meilisearch): another service to run,
  secure and keep in sync, for catalogs of tens of thousands of rows. Reconsider if
  p95 goals are missed.
- **Fuzzy vehicle matching**: risks silently narrowing results to the wrong vehicle.
  Exact matches on names and aliases are predictable, and shops add aliases for their
  own words.

## Consequences

- The target is p95 under 200 ms on 50,000 synthetic parts. Sprint 3b measures it with
  a separate, non-blocking performance test. Vehicle-name matching scans the visible
  vehicle tree. If the tree grows large, an expression index on the normalised names is
  the next step.
- The offline POS (later) can build its local index with the same TypeScript
  normalisers, so online and offline search agree.
- Changing a normalisation rule needs a migration (regenerated columns) and the same
  change in `packages/shared`, or the equivalence test fails.

## Addendum (2026-10-07, Sprints 1–3 review)

These changes replace steps 2–5 of "Interpreting a query" and refine the results.

- **Part-number candidates** come from the query split on whitespace and punctuation, but
  not on `-./_\`, so "04465-60320" stays one number next to any word.
  - Adjacent number tokens are joined ("04465 60320" is 0446560320).
  - Every contiguous join of a run is a candidate, longest first.
  - Within a run, only the longest join that matched anything counts. So the full
    number does not drag in every number that merely starts with 04465.
  - The whole query is no longer a candidate when it holds words.
- **Number lookups** order exact matches first, then shorter numbers, before their limit.
  They also read archived parts, so their replacement can be offered (below).
- **Vehicles before years**: vehicle n-grams are matched on every word first, so "peugeot
  2008" names the model 2008.
  - A 19xx/20xx word left over is a year. Two such words are a range ("2008-2015"), and
    neither stays a required word.
  - A year-like token is also matched as a number, but only exactly. A query that is
    only a year-like token ("2015", a numeric SKU) is matched as a prefix too.
- **The most specific vehicle**:
  - A named vehicle that is an ancestor of another named one is dropped ("toyota land
    cruiser" searches the Land Cruiser, not every Toyota).
  - A vehicle chosen in the UI (`vehicleId`) restricts the typed one: the two scopes
    are intersected, not joined.
- **Replacements follow the chain**:
  - The replacement offered is the last part of the active supersession chain that is
    not archived (A → B archived → C offers C).
  - An archived part found by its number or SKU leads to that replacement as a result,
    with `matchedBy: 'replacement'` (BRIEF scenario 7).
- Measured on 50,000 synthetic parts: p50 57 ms, p95 100 ms (target 200 ms).
