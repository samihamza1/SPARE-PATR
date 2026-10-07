import {
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_SHEET_NAME,
  createImportSchema,
} from '@autoparts/shared';
import type { ImportMapping } from '@autoparts/shared';
import { strToU8 } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/catalog/import/csv';
import { SHEET_MAX_ROWS, SheetTooLargeError } from '../src/catalog/import/limits';
import type { AnalysisInput } from '../src/catalog/import/parse';
import { analyseRows, extractRaw, parseRow } from '../src/catalog/import/parse';
import { cleanNumericText, inspectWorkbook, readWorkbook } from '../src/catalog/import/read';
import type { SheetBounds } from '../src/catalog/import/sheet-scan';
import { cellAddress, scanSheet } from '../src/catalog/import/sheet-scan';
import { ApiError } from '../src/errors';
import { buildXlsx, buildXlsxFromXml, columnName, patchZipEntry, worksheet } from './xlsx';

const PRICE = { minorUnits: 2, roundingMode: 'HALF_EVEN' as const };

const errorCodeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? e.code : 'other'),
  );

/**
 * Each read starts a reader process, which loads TypeScript through tsx when run from
 * source: about a second when the machine is busy. Tests that read several files get the
 * time those processes need, not the 5 s default (a single slower test sets its own).
 */
const READS = 20_000;

describe('reading limits (crafted files)', { timeout: READS }, () => {
  const LIMITS = { maxRows: SHEET_MAX_ROWS, maxColumns: IMPORT_MAX_COLUMNS };

  it('stops a CSV at the row limit: 10 MB of newlines is refused fast', async () => {
    const newlines = '\n'.repeat(IMPORT_MAX_FILE_BYTES);
    const started = performance.now();
    expect(() => parseCsv(newlines, LIMITS)).toThrow(SheetTooLargeError);
    expect(performance.now() - started).toBeLessThan(250);
    expect(await errorCodeOf(readWorkbook(Buffer.from(newlines), 'blank.csv', 'blank'))).toBe(
      'import.too_many_rows',
    );
    // Exactly at the limit is fine.
    expect(parseCsv('a\n'.repeat(SHEET_MAX_ROWS), LIMITS)).toHaveLength(SHEET_MAX_ROWS);
  });

  it('bounds CSV columns: empty fields past the limit are dropped, values refused', () => {
    const wide = `${'a,'.repeat(IMPORT_MAX_COLUMNS)},,,\n`;
    expect(parseCsv(wide, LIMITS)[0]).toHaveLength(IMPORT_MAX_COLUMNS);
    expect(() => parseCsv(`${'a,'.repeat(IMPORT_MAX_COLUMNS)}b\n`, LIMITS)).toThrow(
      SheetTooLargeError,
    );
    // A 10 MB single row of separators stays one short row.
    const commas = ','.repeat(IMPORT_MAX_FILE_BYTES);
    const started = performance.now();
    expect(parseCsv(commas, LIMITS)[0]).toHaveLength(IMPORT_MAX_COLUMNS);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('lists a CSV past the limits as too large when reading all sheets', async () => {
    const sheets = await readWorkbook(Buffer.from('\n'.repeat(SHEET_MAX_ROWS + 1)), 'b.csv');
    expect(sheets).toEqual([{ name: 'b', rows: [], tooLarge: true }]);
  });

  const MB = 1024 * 1024;
  const small = { A: worksheet('<row r="1"><c r="A1"><v>1</v></c></row>') };

  it('refuses a zip whose directory under-declares an entry (zip bomb)', async () => {
    const bomb = buildXlsxFromXml(small, { 'xl/bomb.xml': new Uint8Array(4 * MB) });
    // The directory says 10 bytes; the local header still says 4 MB.
    const lying = patchZipEntry(bomb, 'xl/bomb.xml', { centralSize: 10 });
    expect(await errorCodeOf(readWorkbook(lying, 'bomb.xlsx'))).toBe('import.unreadable_file');
    // Both say 10 bytes, or the local header defers to a data descriptor: inflating stops
    // as soon as the output passes the declared size.
    for (const patch of [
      { centralSize: 10, localSize: 10 },
      { centralSize: 10, dataDescriptor: true },
    ]) {
      const crafted = patchZipEntry(bomb, 'xl/bomb.xml', patch);
      expect(await errorCodeOf(readWorkbook(crafted, 'bomb.xlsx'))).toBe('import.unreadable_file');
    }
    // Unrelated entries (images and the like) are never inflated.
    const image = buildXlsxFromXml(small, { 'xl/media/image1.png': new Uint8Array(4 * MB) });
    const patched = patchZipEntry(image, 'xl/media/image1.png', { centralSize: 10 });
    expect((await readWorkbook(patched, 'image.xlsx'))[0]?.rows).toEqual([['1']]);
  });

  it('refuses a zip that would inflate past 200 MB', async () => {
    const big = buildXlsxFromXml(small, { 'xl/big.xml': new Uint8Array(10) });
    const declared = patchZipEntry(big, 'xl/big.xml', {
      centralSize: 201 * MB,
      localSize: 201 * MB,
    });
    expect(await errorCodeOf(readWorkbook(declared, 'big.xlsx'))).toBe('import.file_too_large');
  });

  it('lists sparse or oversized sheets as too large without building them', async () => {
    const started = performance.now();
    const file = buildXlsxFromXml({
      Catalog: worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Part</t></is></c></row>'),
      // 1,048,576 x 16,384 cells once padded by the reader.
      Corner: worksheet(
        '<row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row>',
      ),
      Far: worksheet('<row r="100000000"><c r="A100000000"><v>1</v></c></row>'),
      Gap: worksheet('<row r="100000000"/>'),
      Wide: worksheet('<row r="1"><c r="A1"><v>1</v></c><c r="CW1"><v>2</v></c></row>'),
      Long: worksheet(
        '<row r="1"><c r="A1"><v>1</v></c></row><row r="21002"><c r="A21002"><v>2</v></c></row>',
      ),
      // What the reader sees is what counts: entities, prefixes and quoted '>' included.
      Entity: worksheet('<row r="1"><c r="&#88;FD1"><v>1</v></c></row>'),
      Prefixed: worksheet(
        '<x:row r="1"><x:c r="XFD1"><x:v>1</x:v></x:c></x:row>',
        ' xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      ),
      // A '>' inside a quoted value can end the tag early when the reader's chunk boundary
      // falls inside the quotes: never written by spreadsheet programs, refused.
      Quoted: worksheet('<row r="1"><c foo="a>b" r="XFD1"><v>1</v></c></row>'),
      // A styled empty cell far away holds no value: the sheet is fine.
      Styled: worksheet(
        '<row r="1"><c r="A1"><v>1</v></c></row><row r="50000"><c r="XFD50000" s="1"/></row>',
      ),
      // 30,001 rows the reader keeps and pads to 100 columns.
      Padded: worksheet(`<row r="1"><c r="CV1"><v>1</v></c></row>${'<row/>'.repeat(30_000)}`),
      // The parser ends `<!-->` and `<?>` right there; what follows is read.
      Comment: worksheet('<!--><row r="2000000"><c r="XFD2000000"><v>1</v></c></row><!-- -->'),
      Question: worksheet('<?><row r="2000000"><c r="XFD2000000"><v>1</v></c></row><?x ?>'),
      // "&Amp;" is not decoded by the parser, so its letters count as a column (49,239).
      MixedCase: worksheet('<row r="1"><c r="A&Amp;1"><v>1</v></c></row>'),
    });
    const sheets = await readWorkbook(file, 'sparse.xlsx');
    expect(sheets.map((s) => [s.name, s.tooLarge === true, s.rows])).toEqual([
      ['Catalog', false, [['Part']]],
      ['Corner', true, []],
      ['Far', true, []],
      ['Gap', true, []],
      ['Wide', true, []],
      ['Long', true, []],
      ['Entity', true, []],
      ['Prefixed', true, []],
      ['Quoted', true, []],
      ['Styled', false, [['1']]],
      ['Padded', true, []],
      ['Comment', true, []],
      ['Question', true, []],
      ['MixedCase', true, []],
    ]);
    const previews = await inspectWorkbook(file, 'sparse.xlsx', 30);
    expect(previews.slice(0, 2)).toEqual([
      { name: 'Catalog', rowCount: 1, columnCount: 1, rows: [['Part']], tooLarge: false },
      { name: 'Corner', rowCount: 0, columnCount: 0, rows: [], tooLarge: true },
    ]);
    // Staging a sheet past the limits is refused; the others still stage.
    expect(await errorCodeOf(readWorkbook(file, 'sparse.xlsx', 'Corner'))).toBe(
      'import.too_many_rows',
    );
    expect((await readWorkbook(file, 'sparse.xlsx', 'Catalog'))[0]?.rows).toEqual([['Part']]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('previews sheets in the worker: counts and the first rows only', async () => {
    const rows = Array.from({ length: 50 }, (_, r) => [`r${String(r)}`, r === 7 ? 'wide' : null]);
    const previews = await inspectWorkbook(buildXlsx({ A: rows, B: [['x']] }), 'p.xlsx', 3);
    expect(previews).toEqual([
      {
        name: 'A',
        rowCount: 50,
        columnCount: 2,
        rows: [
          ['r0', null],
          ['r1', null],
          ['r2', null],
        ],
        tooLarge: false,
      },
      { name: 'B', rowCount: 1, columnCount: 1, rows: [['x']], tooLarge: false },
    ]);
    expect(await errorCodeOf(inspectWorkbook(Buffer.from('x'), 'x.txt', 3))).toBe(
      'import.unreadable_file',
    );
  });

  it('refuses a file that takes the reader past its time or memory limit', async () => {
    const file = buildXlsx({ A: [['x']] });
    expect(
      await errorCodeOf(readWorkbook(file, 'a.xlsx', undefined, { timeoutMs: 1, maxHeapMb: 256 })),
    ).toBe('import.file_too_large');
    const rows = Array.from({ length: 20_000 }, (_, r) =>
      Array.from({ length: 20 }, (_, c) => `row ${String(r)} column ${String(c)}`),
    );
    const heavy = buildXlsx({ A: rows });
    // A heap flag for the API process (NODE_OPTIONS) does not lift the reader's limit, and
    // the reader running out of heap ends only the reader: this process carries on.
    const options = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    try {
      for (let run = 0; run < 3; run++) {
        expect(
          await errorCodeOf(
            readWorkbook(heavy, 'heavy.xlsx', undefined, { timeoutMs: 20_000, maxHeapMb: 32 }),
          ),
        ).toBe('import.file_too_large');
      }
    } finally {
      if (options === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = options;
    }
    // The same file within the normal limits is read.
    expect((await readWorkbook(heavy, 'heavy.xlsx', 'A'))[0]?.rows).toHaveLength(20_000);
  }, 30_000);

  it('reads files in parallel, a bounded number at a time', async () => {
    const file = buildXlsx({ A: [['x']] });
    const all = await Promise.all([1, 2, 3, 4].map(() => readWorkbook(file, 'a.xlsx')));
    expect(all.map((sheets) => sheets[0]?.rows)).toEqual([[['x']], [['x']], [['x']], [['x']]]);
  });
});

describe('scanning sheet XML before it is read', () => {
  const scan = (data: string) => scanSheet(strToU8(worksheet(data)));
  const bounds = (b: Partial<SheetBounds>): SheetBounds => ({
    rows: 0,
    keptRows: 0,
    dataRows: 0,
    dataColumns: 0,
    ambiguous: false,
    ...b,
  });
  /** What the reader itself builds from the sheet, or null when it refuses it. */
  const built = async (data: string) => {
    const sheet = worksheet(data, ' xmlns:x="http://example.com/x"');
    try {
      const rows = await readSheet(buildXlsxFromXml({ S: sheet }), 'S', { trim: false });
      return { rows: rows.length, columns: Math.max(0, ...rows.map((r) => r.length)) };
    } catch {
      return null;
    }
  };

  it('finds the rows the reader holds and keeps, and the last row and column with a value', () => {
    expect(scan('<row r="1"><c r="A1"><v>1</v></c><c r="C1" t="s"><v>0</v></c></row>')).toEqual(
      bounds({ rows: 1, keptRows: 1, dataRows: 1, dataColumns: 3 }),
    );
    // Rows without numbers follow on; a cell numbers its row; styled empty cells hold no
    // value, and empty rows after the last value are dropped.
    expect(
      scan('<row/><row><c r="B2" s="1"/></row><row r="9"><c r="AA9"><f>1+1</f></c></row>'),
    ).toEqual(bounds({ rows: 9 }));
    expect(scan('<row r="2"><c r="ab2" t="inlineStr"><is><t>x</t></is></c></row>')).toEqual(
      // The reader's own arithmetic: lower-case letters count from '@' too.
      bounds({ rows: 2, keptRows: 2, dataRows: 2, dataColumns: cellAddress('ab2')?.[1] ?? 0 }),
    );
    // The last row holds a value, so every row (numberless ones included) is kept and padded.
    expect(scan(`<row r="1"><c r="B1"><v>1</v></c></row>${'<row/>'.repeat(5)}`)).toEqual(
      bounds({ rows: 6, keptRows: 6, dataRows: 1, dataColumns: 2 }),
    );
    // Entries without <sheetData> (shared strings, styles) hold no rows.
    expect(scanSheet(strToU8('<sst><si><t>x</t></si></sst>'))).toEqual(bounds({}));
  });

  it('skips comments, CDATA and processing instructions exactly like the parser', () => {
    expect(
      scan(
        '<!-- <row r="9999999"><c r="XFD9999999"><v>1</v></c></row> --><?pi <row r="5"/> ?><row r="1"><c r="A1"><v><![CDATA[<row r="7777777">]]></v></c></row>',
      ),
    ).toEqual(bounds({ rows: 1, keptRows: 1, dataRows: 1, dataColumns: 1 }));
    // `<!-->` and `<?>` end where they start.
    expect(scan('<!--><row r="7"/><!-- -->').rows).toBe(7);
    expect(scan('<?><row r="8"/><?x ?>').rows).toBe(8);
  });

  it('reads attributes exactly like the parser: entities, prefixes, duplicates', async () => {
    expect(scan('<row r="&#49;0"><c r="&#x41;&#x41;10"><v>1</v></c></row>')).toEqual(
      bounds({ rows: 10, keptRows: 10, dataRows: 10, dataColumns: 27 }),
    );
    expect(scan('<a:row r="3"><a:c x:r="B3"><a:v>1</a:v></a:c></a:row>')).toEqual(
      bounds({ rows: 3, keptRows: 3, dataRows: 3, dataColumns: 2 }),
    );
    // Only lower and upper case entity names are decoded.
    expect(scan('<row r="1"><c r="A&AMP;1"><v>1</v></c></row>').dataColumns).toBe(0);
    expect(scan('<row r="1"><c r="A&Amp;1"><v>1</v></c></row>').dataColumns).toBe(49_239);
    // The reader decodes a prefixed `r` twice when the plain one follows it; the first of
    // two equal names counts; a name the parser skips (space before '=') does not.
    for (const [data, columns] of [
      ['<row r="1"><c x:r="&amp;#88;FD1" r="A1"><v>1</v></c></row>', 16_384],
      ['<row r="1"><c r="A1" r="XFD1"><v>1</v></c></row>', 1],
      ['<row r="1"><c r ="XFD1" r="A1"><v>1</v></c></row>', 1],
    ] as const) {
      expect(scan(data).dataColumns).toBe(columns);
      expect((await built(data))?.columns).toBe(columns);
    }
    // `xmlns:r` is not `r`.
    expect(scan('<row xmlns:r="5"/>').rows).toBe(1);
    // Number() reads exponents and hex, as the reader's Number() does.
    expect(scan('<row r="1e9"/>').rows).toBe(1e9);
    expect(scan('<row><c r="A0x10"><v>1</v></c></row>').dataRows).toBe(16);
  });

  it('reports XML the reader could read differently as ambiguous', () => {
    expect(scan('<row r="1"><c r="A1" a="x>y"><v>1</v></c></row>').ambiguous).toBe(true);
    expect(scan('<x a="<row r=\'99\'/>"/><row r="1"/>').ambiguous).toBe(true);
    expect(scan('<row r="1"/></sheetData><sheetData><row r="2"/>').ambiguous).toBe(true);
    // A '>' in a quoted value elsewhere is harmless.
    expect(scan('<x a="1 > 0"/><row r="1"/>').ambiguous).toBe(false);
  });

  // Seeded, so a failure always reproduces.
  function random(seed: number) {
    let a = seed;
    return (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
  }

  it('never finds less than the reader builds (random tricky sheets)', async () => {
    const pick = random(20261006);
    const rowAttr = (row: number) =>
      [
        '',
        ` r="${String(row)}"`,
        ` r='${String(row)}'`,
        ` x:r="${String(row)}"`,
        ` r="&#${String(String(row).charCodeAt(0))};${String(row).slice(1)}"`,
        ` r ="${String(row + 5)}" r="${String(row)}"`,
        ` r="${String(row)}" r="${String(row + 30)}"`,
      ][pick(7)] ?? '';
    const cell = (row: number, col: number) => {
      const at = `${columnName(col - 1)}${String(row)}`;
      const first = `&#${String(at.charCodeAt(0))};${at.slice(1)}`;
      return [
        `<c r="${at}"><v>1</v></c>`,
        `<c r="${at}" s="1"/>`,
        `<c r="${at}" t="inlineStr"><is><t>x</t></is></c>`,
        `<x:c x:r="${at}"><x:v>2</x:v></x:c>`,
        `<c x:r="&amp;${first.slice(1)}" r="${at}"><v>3</v></c>`,
        `<c r="${first}"><v>4</v></c>`,
        `<c r="${at}"><v></v></c>`,
        `<c r="${at}" r="XFD${String(row)}"><v>5</v></c>`,
        `<c r ="XFD${String(row)}" r="${at}"><v>6</v></c>`,
        `<c r="${at}" a='>'><v>7</v></c>`,
      ][pick(10)];
    };
    let compared = 0;
    for (let sample = 0; sample < 300; sample++) {
      let xml = '';
      let row = 0;
      for (let r = pick(12); r > 0; r--) {
        row += 1 + pick(4);
        const columns = [...new Set(Array.from({ length: pick(4) }, () => 1 + pick(40)))];
        const cells = columns
          .sort((a, b) => a - b)
          .map((c) => cell(row, c))
          .join('');
        const item = pick(6) === 0 ? `<row${rowAttr(row)}/>` : `<row${rowAttr(row)}>${cells}</row>`;
        xml += [`<!-->${item}<!-- -->`, `<?>${item}<?x ?>`, `<!-- ${item} -->`][pick(8)] ?? item;
      }
      const reader = await built(xml);
      if (reader === null) continue; // Refused by the reader: nothing is built.
      compared++;
      const found = scanSheet(strToU8(worksheet(xml, ' xmlns:x="http://example.com/x"')));
      if (found.ambiguous) continue;
      expect({
        xml,
        rows: found.keptRows >= reader.rows && found.rows >= reader.rows,
        columns: found.dataColumns >= reader.columns,
      }).toEqual({ xml, rows: true, columns: true });
    }
    expect(compared).toBeGreaterThan(100);
  });
});

describe('reading files', { timeout: READS }, () => {
  it('reads every sheet of an xlsx, numbers as exact text cut to Excel precision', async () => {
    const file = buildXlsx({
      Catalog: [
        ['Title row', null],
        ['No', 'Part', 'Price'],
        [{ n: '1' }, '04465-60320', { n: '17.850000000000001' }],
        [{ n: '2' }, '   ', { n: '13.160762942779291' }],
        [null, null, null],
      ],
      Private: [['not', 'needed']],
    });
    const sheets = await readWorkbook(file, 'stock.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['Catalog', 'Private']);
    // Rows are padded to the sheet width.
    expect(sheets[0]?.rows).toEqual([
      ['Title row', null, null],
      ['No', 'Part', 'Price'],
      ['1', '04465-60320', '17.85'],
      // Whitespace-only cells are empty; 15 significant digits, as Excel shows them.
      ['2', null, '13.1607629427793'],
    ]);
    const one = await readWorkbook(file, 'stock.xlsx', 'Catalog');
    expect(one.map((s) => s.name)).toEqual(['Catalog']);
  });

  it('rejects unknown sheets, legacy .xls, other files and invalid UTF-8 CSV', async () => {
    const file = buildXlsx({ A: [['x']] });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: unknown) => (e instanceof ApiError ? e.code : 'other'),
      );
    expect(await code(readWorkbook(file, 'f.xlsx', 'B'))).toBe('import.sheet_not_found');
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await code(readWorkbook(xls, 'old.xls'))).toBe('import.unreadable_file');
    expect(await code(readWorkbook(Buffer.from('hello'), 'notes.txt'))).toBe(
      'import.unreadable_file',
    );
    expect(await code(readWorkbook(Buffer.from([0xff, 0xfe, 0x41]), 'bad.csv'))).toBe(
      'import.unreadable_file',
    );
    const truncated = file.subarray(0, 40);
    expect(await code(readWorkbook(truncated, 'cut.xlsx'))).toBe('import.unreadable_file');
  });

  it('reads UTF-8 CSV with quotes, embedded commas and CRLF', async () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n1,,3\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '', '3'],
    ]);
    const [sheet] = await readWorkbook(Buffer.from('رقم,اسم\n123,فلتر\n'), 'parts.csv');
    expect(sheet).toEqual({
      name: 'parts',
      rows: [
        ['رقم', 'اسم'],
        ['123', 'فلتر'],
      ],
    });
  });

  it('names a CSV sheet after the file, cut to the longest sheet name a batch accepts', async () => {
    const long = `${'x'.repeat(150)}.csv`;
    const [sheet] = await readWorkbook(Buffer.from('a,b\n'), long);
    expect(sheet?.name).toBe('x'.repeat(IMPORT_MAX_SHEET_NAME));
    // Staging sends the name back; it must be accepted, and match the file again.
    expect(createImportSchema.shape.sheet.safeParse(sheet?.name).success).toBe(true);
    expect((await readWorkbook(Buffer.from('a,b\n'), long, sheet?.name))[0]?.rows).toEqual([
      ['a', 'b'],
    ]);
    // Never cut between the two halves of a character outside the BMP.
    const emoji = `${'x'.repeat(IMPORT_MAX_SHEET_NAME - 1)}🚗 parts.csv`;
    const [cut] = await readWorkbook(Buffer.from('a\n'), emoji);
    expect(cut?.name).toBe('x'.repeat(IMPORT_MAX_SHEET_NAME - 1));
  });

  it('keeps non-numeric text from numeric cleaning', () => {
    expect(cleanNumericText('1E-3')).toBe('0.001');
    expect(cleanNumericText('1.2345678901234567E+15')).toBe('1234567890123460');
    expect(cleanNumericText('abc')).toBe('abc');
  });

  it('keeps integers exactly: long numeric part numbers are not float artefacts', () => {
    expect(cleanNumericText('1234567890123456')).toBe('1234567890123456');
    expect(cleanNumericText('12345678901234567')).toBe('12345678901234567');
    expect(cleanNumericText('99999999999999999999')).toBe('99999999999999999999');
    expect(cleanNumericText(' 42 ')).toBe('42');
    // Only values with a fraction or an exponent are cut to 15 significant digits.
    expect(cleanNumericText('17.850000000000001')).toBe('17.85');
  });

  it('never expands huge exponents (left as read, so the value is refused later)', () => {
    const started = Date.now();
    for (const text of ['1E+100000000', '1E-10000000', '1e31', '9.9E+200000']) {
      expect(cleanNumericText(text)).toBe(text);
    }
    // 30 is the largest exponent expanded; beyond 40 characters the text is kept too.
    expect(cleanNumericText('1E+30')).toBe(`1${'0'.repeat(30)}`);
    expect(cleanNumericText('1.23456789012345E-30')).toBe('1.23456789012345E-30');
    expect(Date.now() - started).toBeLessThan(200);
    const price = parseRow(
      { partNumber: 'A-1', nameEn: 'Pad', sellPrice: cleanNumericText('1E+100000000') },
      PRICE,
    );
    expect(price.issues).toEqual(['bad_price']);
  });
});

const mapping: ImportMapping = {
  columns: {
    partNumber: 1,
    nameEn: 2,
    nameAr: 3,
    vehicleCode: 4,
    sellPrice: 5,
    cost: 6,
    quantity: 7,
  },
  numberKind: 'oem',
  priceListId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
  costCurrency: 'BBB',
  skuPrefix: 'SKY',
};

describe('parsing a row', () => {
  const row = (cells: (string | null)[]) => parseRow(extractRaw(cells, mapping), PRICE);

  it('cleans values, rounds the selling price and keeps cost and quantity as read', () => {
    const r = row([
      '1',
      ' 04465-60320 ',
      'Pad,  Front',
      'فحمات امامية',
      'LC',
      '17.855',
      '13.1607629427793',
      '2',
    ]);
    expect(r.parsed).toEqual({
      partNumber: '04465-60320',
      partNumberNorm: '0446560320',
      nameEn: 'Pad, Front',
      nameAr: 'فحمات امامية',
      vehicleCode: 'LC',
      vehicleCodeNorm: 'lc',
      sellPrice: '17.86',
      sellPriceRaw: '17.855',
      cost: '13.1607629427793',
      quantity: '2',
    });
    expect(r.issues).toEqual(['price_rounded']);
    expect(r.rowKey).toBe('0446560320|pad front|lc');
  });

  it('flags missing, zero and unreadable values without guessing', () => {
    expect(row(['1', null, 'Battery', null, null, null, null, null]).issues).toEqual([
      'no_part_number',
      'no_price',
    ]);
    const zero = row(['1', 'N70', 'Battery', null, null, '0', null, '0']);
    expect([zero.issues, zero.parsed.sellPrice]).toEqual([['zero_price'], '0.00']);
    // "1,200" could be 1200 or 1.2: refused, not guessed.
    expect(row(['1', 'N70', 'Battery', null, null, '1,200', 'x', '-1']).issues).toEqual([
      'bad_price',
      'bad_cost',
      'bad_quantity',
    ]);
    expect(row(['1', 'N70', null, null, null, '5', null, null]).issues).toEqual(['no_name']);
    expect(row(['9', null, '  ', null, null, null, null, null]).issues).toEqual(['empty_row']);
    // Arabic-Indic digits are unambiguous and accepted.
    expect(row(['1', 'N70', 'Battery', null, null, '١٢٫٥', null, null]).parsed.sellPrice).toBe(
      '12.50',
    );
  });

  it('flags a price that rounds to zero as zero_price', () => {
    const tiny = parseRow({ partNumber: 'C-1', nameEn: 'Clip', sellPrice: '0.004' }, PRICE);
    expect([tiny.parsed.sellPrice, tiny.issues]).toEqual(['0.00', ['zero_price', 'price_rounded']]);
    const down = parseRow(
      { partNumber: 'C-1', nameEn: 'Clip', sellPrice: '0.9' },
      { minorUnits: 0, roundingMode: 'DOWN' },
    );
    expect([down.parsed.sellPrice, down.issues]).toEqual(['0', ['zero_price', 'price_rounded']]);
    expect(
      parseRow({ partNumber: 'C-1', nameEn: 'Clip', sellPrice: '0.006' }, PRICE).issues,
    ).toEqual(['price_rounded']);
  });

  it('refuses numbers longer than any real price, cost or quantity', () => {
    const long = '9'.repeat(41);
    const r = parseRow(
      { partNumber: 'A-1', nameEn: 'Pad', sellPrice: long, cost: long, quantity: long },
      PRICE,
    );
    expect(r.issues).toEqual(['bad_price', 'bad_cost', 'bad_quantity']);
    expect(
      parseRow({ partNumber: 'A-1', nameEn: 'Pad', sellPrice: '9'.repeat(40) }, PRICE).issues,
    ).toEqual([]);
  });

  it('stores only the mapped columns', () => {
    expect(extractRaw(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'secret'], mapping)).toEqual({
      partNumber: 'b',
      nameEn: 'c',
      nameAr: 'd',
      vehicleCode: 'e',
      sellPrice: 'f',
      cost: 'g',
      quantity: 'h',
    });
  });
});

describe('analysing rows', () => {
  const input = (
    rowNumber: number,
    cells: (string | null)[],
    skippedByUser = false,
  ): AnalysisInput => ({
    rowNumber,
    ...parseRow(extractRaw(cells, mapping), PRICE),
    skippedByUser,
  });
  const empty = {
    priorParts: new Map(),
    mappedCodes: new Set(['lc']),
    existingSkus: new Set<string>(),
  };

  it('creates new parts, merges repeats and warns about price conflicts', () => {
    const rows = [
      input(4, ['1', 'A-1', 'Filter', null, 'LC', '10', null, '1']),
      input(5, ['2', 'A-1', 'Filter', null, 'lc', '12', null, '3']),
      input(6, ['3', 'A-1', 'Filter', null, 'HILUX', '10', null, '1']),
      input(7, ['4', null, null, null, null, null, null, null]),
    ];
    const result = analyseRows(rows, empty);
    expect(result.map((r) => r.decision)).toEqual(['create', 'merge', 'create', 'skip']);
    expect(result[1]?.issues).toEqual(['shared_number', 'duplicate_row', 'price_conflict']);
    // Same number, different vehicle code: a separate part, flagged.
    expect(result[2]?.issues).toEqual(['vehicle_unmapped', 'shared_number']);
    expect(result[3]?.issues).toEqual(['empty_row']);
  });

  it('updates parts from an earlier import instead of duplicating them', () => {
    const rows = [input(4, ['1', 'A-1', 'Filter', null, 'LC', '10', null, '1'])];
    const prior = new Map([['A1|filter|lc', 'part-1']]);
    const [r] = analyseRows(rows, { ...empty, priorParts: prior });
    expect(r).toEqual({ decision: 'update', issues: ['existing_part'], partId: 'part-1' });
  });

  it('merges a repeat of an updated row into the same earlier part', () => {
    const rows = [
      input(4, ['1', 'A-1', 'Filter', null, 'LC', '10', null, '1']),
      input(5, ['2', 'A-1', 'Filter', null, 'LC', '11', null, '1']),
    ];
    const prior = new Map([['A1|filter|lc', 'part-1']]);
    expect(analyseRows(rows, { ...empty, priorParts: prior })).toEqual([
      { decision: 'update', issues: ['existing_part'], partId: 'part-1' },
      {
        decision: 'merge',
        issues: ['existing_part', 'duplicate_row', 'price_conflict'],
        partId: 'part-1',
      },
    ]);
  });

  it('honours a user skip and lets the next repeat create the part', () => {
    const rows = [
      input(4, ['1', 'A-1', 'Filter', null, 'LC', '10', null, '1'], true),
      input(5, ['2', 'A-1', 'Filter', null, 'LC', '10', null, '1']),
    ];
    expect(analyseRows(rows, empty).map((r) => r.decision)).toEqual(['skip', 'create']);
  });

  it('refuses SKUs that are invalid or already used', () => {
    const withSku: ImportMapping = { ...mapping, columns: { sku: 0, nameEn: 2 }, skuPrefix: null };
    const rows = [
      {
        rowNumber: 2,
        ...parseRow(extractRaw(['FLT-1', null, 'Filter'], withSku), PRICE),
        skippedByUser: false,
      },
      {
        rowNumber: 3,
        ...parseRow(extractRaw(['FLT-1', null, 'Other'], withSku), PRICE),
        skippedByUser: false,
      },
      {
        rowNumber: 4,
        ...parseRow(extractRaw(['OLD-9', null, 'Pad'], withSku), PRICE),
        skippedByUser: false,
      },
      {
        rowNumber: 5,
        ...parseRow(extractRaw(['bad sku!', null, 'Pad'], withSku), PRICE),
        skippedByUser: false,
      },
    ];
    const result = analyseRows(rows, { ...empty, existingSkus: new Set(['OLD-9']) });
    expect(result.map((r) => [r.decision, r.issues.filter((i) => i.includes('sku'))])).toEqual([
      ['create', []],
      ['skip', ['sku_taken']],
      ['skip', ['sku_taken']],
      ['skip', ['bad_sku']],
    ]);
  });
});
