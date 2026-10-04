import { normalizePartNumber, normalizeSearchText } from '@autoparts/shared';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { ownerDb } from './helpers';

const db = ownerDb();
afterAll(() => db.destroy());

// Characters the normalizers treat specially, plus ordinary ones around them.
// Split into code points on purpose: combining marks must be separate characters.
const POOL = Array.from(
  [
    'ابتثجحخدذرزسشصضطظعغفقكلمنهوي',
    'أإآٱىئؤةء',
    'ًٌٍَُِّْٰـ',
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹0123456789',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzéÉ',
    ',.;:/\\_-(){}[]"\'*+#&|!?،؛—%@',
    '    \t\n\r\f\v',
  ].join(''),
);
const arbText = fc.array(fc.constantFrom(...POOL), { maxLength: 40 }).map((cs) => cs.join(''));

async function sqlNormalize(values: string[]) {
  const { rows } = await sql<{ s: string; p: string }>`
    SELECT normalize_search(v) AS s, normalize_part_number(v) AS p
    FROM unnest(${values}::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i`.execute(db);
  return rows;
}

describe('search normalisation: SQL and TypeScript agree', () => {
  it('on fixed examples', async () => {
    const examples = [
      '  فِلْتَر  زيتٍ أإآ ة ى ٢٠١٨',
      'Filter , Oil LC',
      '90915- yzzd2',
      'جلود باكم فرمل',
    ];
    const rows = await sqlNormalize(examples);
    expect(rows.map((r) => r.s)).toEqual(examples.map(normalizeSearchText));
    expect(rows.map((r) => r.p)).toEqual(examples.map(normalizePartNumber));
    expect(normalizeSearchText(examples[0] ?? '')).toBe('فلتر زيت ااا ه ي 2018');
    expect(normalizePartNumber('90915- yzzd2')).toBe('90915YZZD2');
  });

  it('on random input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbText, { minLength: 1, maxLength: 50 }), async (values) => {
        const rows = await sqlNormalize(values);
        expect(rows.map((r) => r.s)).toEqual(values.map(normalizeSearchText));
        expect(rows.map((r) => r.p)).toEqual(values.map(normalizePartNumber));
      }),
      { numRuns: 60 },
    );
  });
});
