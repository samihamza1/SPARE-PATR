import { Decimal, IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, toDecimalString } from '@autoparts/shared';
import type { ImportCell } from '@autoparts/shared';
import { unzipSync } from 'fflate';
import readExcelFile, { SheetNotFoundError, readSheet } from 'read-excel-file/node';
import { ApiError } from '../../errors';
import { parseCsv } from './csv';

export interface WorkbookSheet {
  name: string;
  /** Cells as text; null for empty or whitespace-only cells. Trailing empty rows dropped. */
  rows: ImportCell[][];
}

/** Excel keeps 15 significant digits; longer numbers in a file are binary float artefacts. */
const EXCEL_DIGITS = 15;
/** Decompressed size limit for an .xlsx (a zip); guards against zip bombs. */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

const unreadable = () => new ApiError(400, 'import.unreadable_file');

/** Numeric cells keep their stored text, so no value ever passes through a JS float. */
interface NumericText {
  numeric: string;
}

export function cleanNumericText(text: string): string {
  let value: Decimal;
  try {
    value = new Decimal(text.trim());
  } catch {
    return text.trim();
  }
  if (!value.isFinite()) return text.trim();
  return toDecimalString(value.toSignificantDigits(EXCEL_DIGITS));
}

function toCell(value: unknown): ImportCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'numeric' in value) {
    return cleanNumericText((value as NumericText).numeric);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  return null;
}

function toRows(data: readonly (readonly unknown[])[]): ImportCell[][] {
  if (data.length > IMPORT_MAX_ROWS + 1000) throw new ApiError(400, 'import.too_many_rows');
  const rows = data.map((r) => r.slice(0, IMPORT_MAX_COLUMNS).map(toCell));
  while (rows.length > 0 && (rows.at(-1) ?? []).every((c) => c === null)) rows.pop();
  return rows;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function assertUnzippedSize(bytes: Uint8Array): void {
  let total = 0;
  try {
    // The filter sees each entry's declared size and decompresses nothing.
    unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        return false;
      },
    });
  } catch {
    throw unreadable();
  }
  if (total > MAX_UNZIPPED_BYTES) throw unreadable();
}

/**
 * Reads an .xlsx (all sheets, or only `only`) or a UTF-8 .csv (one sheet named after the
 * file). The bytes are never stored (ADR 0016).
 */
export async function readWorkbook(
  bytes: Buffer,
  fileName: string,
  only?: string,
): Promise<WorkbookSheet[]> {
  if (isZip(bytes)) {
    assertUnzippedSize(bytes);
    const options = {
      trim: false,
      parseNumber: (text: string): NumericText => ({ numeric: text }),
    };
    try {
      if (only !== undefined) {
        return [{ name: only, rows: toRows(await readSheet(bytes, only, options)) }];
      }
      const sheets = await readExcelFile(bytes, options);
      return sheets.map((s) => ({ name: s.sheet, rows: toRows(s.data) }));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SheetNotFoundError) throw new ApiError(400, 'import.sheet_not_found');
      throw unreadable();
    }
  }
  if (!/\.csv$/i.test(fileName)) throw unreadable();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unreadable();
  }
  const name = fileName.replace(/\.csv$/i, '');
  if (only !== undefined && only !== name) throw new ApiError(400, 'import.sheet_not_found');
  return [{ name, rows: toRows(parseCsv(text)) }];
}
