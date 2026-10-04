-- migrate:up

-- Search support for the catalog (ADR 0015). pg_trgm and btree_gin are trusted extensions,
-- so the database owner can create them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Normalised text for matching names in Arabic and English. Kept byte-for-byte equivalent
-- to normalizeSearchText() in packages/shared (a test compares them on random input):
--   * drop Arabic diacritics (U+064B..U+065F, U+0670) and tatweel (U+0640);
--   * unify alef forms, alef maqsura/yeh-hamza -> yeh, waw-hamza -> waw, teh marbuta -> heh;
--   * Arabic-Indic and Persian digits -> ASCII digits;
--   * ASCII letters -> lower case (ASCII only, independent of the database locale);
--   * punctuation and every whitespace character -> one space; trim.
CREATE FUNCTION normalize_search(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $fn$
    SELECT btrim(regexp_replace(
      translate(
        translate(value, E'\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0653\u0654\u0655\u0656\u0657\u0658\u0659\u065A\u065B\u065C\u065D\u065E\u065F\u0670\u0640', ''),
        E'\u0623\u0625\u0622\u0671\u0649\u0626\u0624\u0629\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9ABCDEFGHIJKLMNOPQRSTUVWXYZ,.;:/\\_-(){}[]"\'*+#&|!?\u060C\u061B\u00A0\u2007\u202F\u0009\u000A\u000D\u000C\u000B',
        E'\u0627\u0627\u0627\u0627\u064A\u064A\u0648\u064701234567890123456789abcdefghijklmnopqrstuvwxyz                                 '),
      ' +', ' ', 'g'))
  $fn$;

-- Part numbers compare without spaces, dashes, dots, slashes or underscores, in upper case,
-- with ASCII digits. Equivalent to normalizePartNumber() in packages/shared.
CREATE FUNCTION normalize_part_number(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $fn$
    SELECT translate(value,
      E'\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9abcdefghijklmnopqrstuvwxyz \u00A0\u2007\u202F\u0009\u000A\u000D\u000C\u000B-./_\\',
      E'01234567890123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  $fn$;

-- migrate:down

DROP FUNCTION normalize_part_number(text);
DROP FUNCTION normalize_search(text);
DROP EXTENSION btree_gin;
DROP EXTENSION pg_trgm;
