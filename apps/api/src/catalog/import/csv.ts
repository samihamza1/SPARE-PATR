import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetTooLargeError } from './limits';

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
}

/**
 * Minimal RFC 4180 reader: comma-separated, double-quoted fields with "" escapes, CRLF or
 * LF line ends. A UTF-8 byte-order mark is dropped. Returns rows of raw field text.
 * Reading stops with SheetTooLargeError as soon as a row past `maxRows`, or a value past
 * `maxColumns`, is met; empty fields past `maxColumns` are dropped.
 */
export function parseCsv(
  text: string,
  limits: CsvLimits = { maxRows: SHEET_MAX_ROWS, maxColumns: SHEET_MAX_COLUMNS },
): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    if (row.length < limits.maxColumns) row.push(field);
    else if (field.trim() !== '') throw new SheetTooLargeError();
    field = '';
  };
  const endRow = () => {
    endField();
    if (rows.length >= limits.maxRows) throw new SheetTooLargeError();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (quoted) {
      if (ch === '"' && input.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input.charAt(i + 1) === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
