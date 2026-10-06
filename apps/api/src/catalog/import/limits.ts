import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS } from '@autoparts/shared';

/**
 * Sheet size limits, enforced while a file is read and before a sheet is built in memory
 * (ADR 0016). A sheet may have up to 1,000 rows above its data (titles, notes, the header).
 */
export const SHEET_MAX_ROWS = IMPORT_MAX_ROWS + 1000;
export const SHEET_MAX_COLUMNS = IMPORT_MAX_COLUMNS;

/** A sheet past the limits: inspect lists it as too large, staging refuses it. */
export class SheetTooLargeError extends Error {
  constructor() {
    super('sheet too large');
    this.name = 'SheetTooLargeError';
  }
}
