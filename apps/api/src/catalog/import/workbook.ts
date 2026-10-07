import { randomUUID } from 'node:crypto';
import { Decimal, IMPORT_MAX_SHEET_NAME, toDecimalString } from '@autoparts/shared';
import type { ErrorCode, ImportCell, ImportSheetPreview } from '@autoparts/shared';
import { strToU8, zipSync } from 'fflate';
import readExcelFile, { SheetNotFoundError, readSheet } from 'read-excel-file/node';
import { ApiError } from '../../errors';
import { parseCsv } from './csv';
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetTooLargeError } from './limits';
import type { SheetBounds } from './sheet-scan';
import { scanSheet } from './sheet-scan';
import { ZipTooLargeError, unzipBounded } from './zip';

/**
 * Reading an uploaded file in the current thread. The API runs this in a worker thread with
 * memory and time limits (read.ts); nothing here may be called on the API's main thread.
 */

export interface WorkbookSheet {
  name: string;
  /** Cells as text; null for empty or whitespace-only cells. Trailing empty rows dropped. */
  rows: ImportCell[][];
  /** Past the row or column limit: listed without rows, and cannot be staged. */
  tooLarge?: true;
}

/**
 * What a worker is asked: the sheets' rows (staging), or a preview of every sheet (inspect),
 * so only the first rows of each sheet travel back to the API thread.
 */
export type ReadRequest =
  | { kind: 'sheets'; bytes: Uint8Array; fileName: string; only?: string }
  | { kind: 'preview'; bytes: Uint8Array; fileName: string; sampleRows: number };
export type ReadResponse =
  | { ok: true; sheets: WorkbookSheet[] }
  | { ok: true; previews: ImportSheetPreview[] }
  | { ok: false; code: ErrorCode };

/** Excel keeps 15 significant digits; longer fractions in a file are binary float artefacts. */
const EXCEL_DIGITS = 15;
/** Beyond any real price, cost or quantity; larger exponents are not expanded. */
const MAX_EXPONENT = 30;
const MAX_NUMBER_TEXT = 40;
const INTEGER_TEXT = /^-?\d+$/;
/** Inflated size limit for an .xlsx (a zip), counted on the bytes really inflated. */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
/** Excel's own row limit: more rows than this (empty ones included) is not a real sheet. */
const EXCEL_MAX_ROWS = 1_048_576;

const unreadable = () => new ApiError(400, 'import.unreadable_file');

/** Numeric cells keep their stored text, so no value ever passes through a JS float. */
interface NumericText {
  numeric: string;
}

/**
 * A numeric cell's stored text as a plain decimal. Integers are kept exactly (16-17 digit
 * part numbers are not float artefacts); values with a fraction or an exponent are cut to
 * Excel's precision. Huge exponents are left as read, so the cell is refused later
 * (bad_price, bad_cost, bad_quantity) instead of expanding into millions of digits.
 */
export function cleanNumericText(text: string): string {
  const trimmed = text.trim();
  if (INTEGER_TEXT.test(trimmed)) return trimmed;
  let value: Decimal;
  try {
    value = new Decimal(trimmed);
  } catch {
    return trimmed;
  }
  if (!value.isFinite()) return trimmed;
  const cut = value.toSignificantDigits(EXCEL_DIGITS);
  if (Math.abs(cut.e) > MAX_EXPONENT) return trimmed;
  const plain = toDecimalString(cut);
  return plain.length > MAX_NUMBER_TEXT ? trimmed : plain;
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
  // The pre-scan keeps sheets past the limits from being built; this is a backstop.
  if (data.length > SHEET_MAX_ROWS) throw new SheetTooLargeError();
  const rows = data.map((r) => r.slice(0, SHEET_MAX_COLUMNS).map(toCell));
  while (rows.length > 0 && (rows.at(-1) ?? []).every((c) => c === null)) rows.pop();
  return rows;
}

/** Inspect lists a sheet past the limits instead of failing the whole workbook. */
function toSheet(name: string, read: () => ImportCell[][]): WorkbookSheet {
  try {
    return { name, rows: read() };
  } catch (err) {
    if (err instanceof SheetTooLargeError) return { name, rows: [], tooLarge: true };
    throw err;
  }
}

export function sheetTooLarge(bounds: SheetBounds): boolean {
  return (
    bounds.ambiguous ||
    bounds.rows > EXCEL_MAX_ROWS ||
    bounds.dataRows > SHEET_MAX_ROWS ||
    bounds.keptRows > SHEET_MAX_ROWS ||
    bounds.dataColumns > SHEET_MAX_COLUMNS
  );
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The entries read-excel-file reads; the others (images, printer settings) are skipped. */
const xmlEntry = (name: string) => name.endsWith('.xml') || name.endsWith('.xml.rels');

/** A one-cell sheet standing in for one past the limits; the random marker identifies it. */
const markerSheet = (marker: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${marker}</t></is></c></row></sheetData></worksheet>`;
const isMarker = (data: readonly (readonly unknown[])[], marker: string) =>
  data.length === 1 && data[0]?.length === 1 && data[0][0] === marker;

/**
 * The archive the library reads: only the entries inflated and checked here, zipped again
 * (stored), with every sheet past the limits swapped for a marker sheet so it is never
 * built. Every entry is scanned, wherever the workbook's relationships point; the library's
 * own sheet lookup then names the swapped sheets.
 */
function checkedArchive(bytes: Uint8Array, marker: string): Buffer {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipBounded(bytes, xmlEntry, MAX_UNZIPPED_BYTES);
  } catch (err) {
    if (err instanceof ZipTooLargeError) throw new ApiError(400, 'import.file_too_large');
    throw unreadable();
  }
  for (const [path, xml] of Object.entries(files)) {
    if (sheetTooLarge(scanSheet(xml))) files[path] = strToU8(markerSheet(marker));
  }
  const archive = zipSync(files, { level: 0 });
  return Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
}

async function readXlsx(bytes: Uint8Array, only: string | undefined): Promise<WorkbookSheet[]> {
  const marker = randomUUID();
  const input = checkedArchive(bytes, marker);
  const options = {
    trim: false,
    parseNumber: (text: string): NumericText => ({ numeric: text }),
  };
  try {
    if (only !== undefined) {
      const data = await readSheet(input, only, options);
      if (isMarker(data, marker)) throw new SheetTooLargeError();
      return [{ name: only, rows: toRows(data) }];
    }
    const sheets = await readExcelFile(input, options);
    return sheets.map((s) =>
      isMarker(s.data, marker)
        ? { name: s.sheet, rows: [], tooLarge: true }
        : toSheet(s.sheet, () => toRows(s.data)),
    );
  } catch (err) {
    if (err instanceof ApiError || err instanceof SheetTooLargeError) throw err;
    if (err instanceof SheetNotFoundError) throw new ApiError(400, 'import.sheet_not_found');
    throw unreadable();
  }
}

/** The file name without .csv, cut to the longest sheet name a batch keeps. */
function csvSheetName(fileName: string): string {
  const name = fileName.replace(/\.csv$/i, '');
  if (name.length <= IMPORT_MAX_SHEET_NAME) return name;
  // Never cut between the two halves of a surrogate pair.
  const last = name.charCodeAt(IMPORT_MAX_SHEET_NAME - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? IMPORT_MAX_SHEET_NAME - 1 : IMPORT_MAX_SHEET_NAME;
  return name.slice(0, end);
}

function readCsv(bytes: Uint8Array, fileName: string, only: string | undefined) {
  if (!/\.csv$/i.test(fileName)) throw unreadable();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unreadable();
  }
  const name = csvSheetName(fileName);
  if (only !== undefined && only !== name) throw new ApiError(400, 'import.sheet_not_found');
  return [toSheet(name, () => toRows(parseCsv(text)))];
}

/**
 * Reads an .xlsx (all sheets, or only `only`) or a UTF-8 .csv (one sheet named after the
 * file). The bytes are never stored (ADR 0016). Sheets past the limits are listed with
 * `tooLarge` when reading all sheets, and refused (import.too_many_rows) when staging.
 */
export async function readWorkbookInThread(
  bytes: Uint8Array,
  fileName: string,
  only?: string,
): Promise<WorkbookSheet[]> {
  try {
    const sheets = isZip(bytes) ? await readXlsx(bytes, only) : readCsv(bytes, fileName, only);
    if (only !== undefined && sheets.some((s) => s.tooLarge === true)) {
      throw new SheetTooLargeError();
    }
    return sheets;
  } catch (err) {
    if (err instanceof SheetTooLargeError) throw new ApiError(400, 'import.too_many_rows');
    throw err;
  }
}

function previewOf(sheet: WorkbookSheet, sampleRows: number): ImportSheetPreview {
  let columnCount = 0;
  for (const row of sheet.rows) columnCount = Math.max(columnCount, row.length);
  return {
    name: sheet.name,
    rowCount: sheet.rows.length,
    columnCount,
    rows: sheet.rows.slice(0, sampleRows),
    tooLarge: sheet.tooLarge === true,
  };
}

/** Answers one request; every failure becomes an error code. */
export async function handleReadRequest(request: ReadRequest): Promise<ReadResponse> {
  try {
    if (request.kind === 'preview') {
      const sheets = await readWorkbookInThread(request.bytes, request.fileName);
      return { ok: true, previews: sheets.map((s) => previewOf(s, request.sampleRows)) };
    }
    const sheets = await readWorkbookInThread(request.bytes, request.fileName, request.only);
    return { ok: true, sheets };
  } catch (err) {
    return { ok: false, code: err instanceof ApiError ? err.code : 'import.unreadable_file' };
  }
}
