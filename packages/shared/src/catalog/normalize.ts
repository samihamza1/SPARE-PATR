/**
 * Text normalisation for catalog search (ADR 0015). Must stay equivalent to the SQL
 * functions normalize_search() and normalize_part_number() in db/migrations; a database
 * test compares both on random input.
 */

// Arabic diacritics (U+064B..U+065F), superscript alef (U+0670) and tatweel (U+0640).
const DIACRITICS = new Set(
  '\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652\u0653\u0654\u0655\u0656\u0657\u0658\u0659\u065a\u065b\u065c\u065d\u065e\u065f\u0670\u0640',
);

// Alef forms, yeh/waw with hamza, teh marbuta, Arabic-Indic and Persian digits, ASCII
// upper case, then punctuation and whitespace mapped to a space.
const SEARCH_FROM =
  '\u0623\u0625\u0622\u0671\u0649\u0626\u0624\u0629\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9ABCDEFGHIJKLMNOPQRSTUVWXYZ,.;:/\\_-(){}[]"\'*+#&|!?\u060c\u061b\u00a0\u2007\u202f\t\n\r\f\u000b';
const SEARCH_TO =
  '\u0627\u0627\u0627\u0627\u064a\u064a\u0648\u064701234567890123456789abcdefghijklmnopqrstuvwxyz                                 ';

const PART_NUMBER_FROM =
  '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9abcdefghijklmnopqrstuvwxyz \u00a0\u2007\u202f\t\n\r\f\u000b-./_\\';
// Characters past the end of PART_NUMBER_TO are removed (as SQL translate() does).
const PART_NUMBER_TO = '01234567890123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Like SQL translate(): map each char of `from` to the same position in `to`, else drop it. */
function translate(value: string, from: string, to: string): string {
  const map = new Map<string, string>();
  const fromChars = Array.from(from);
  const toChars = Array.from(to);
  fromChars.forEach((ch, i) => {
    if (!map.has(ch)) map.set(ch, toChars[i] ?? '');
  });
  let out = '';
  for (const ch of value) out += map.get(ch) ?? ch;
  return out;
}

export function normalizeSearchText(value: string): string {
  let stripped = '';
  for (const ch of value) if (!DIACRITICS.has(ch)) stripped += ch;
  return translate(stripped, SEARCH_FROM, SEARCH_TO).replace(/ +/g, ' ').trim();
}

export function normalizePartNumber(value: string): string {
  return translate(value, PART_NUMBER_FROM, PART_NUMBER_TO);
}
