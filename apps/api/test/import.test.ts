import type { ImportMapping } from '@autoparts/shared';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/catalog/import/csv';
import type { AnalysisInput } from '../src/catalog/import/parse';
import { analyseRows, extractRaw, parseRow } from '../src/catalog/import/parse';
import { cleanNumericText, readWorkbook } from '../src/catalog/import/read';
import { ApiError } from '../src/errors';
import { buildXlsx } from './xlsx';

const PRICE = { minorUnits: 2, roundingMode: 'HALF_EVEN' as const };

describe('reading files', () => {
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
