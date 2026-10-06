import { z } from 'zod';

/**
 * Stock quantities are whole units (product owner, 2026-10-06): no fractions. The bound
 * keeps every quantity, and any sum of a few of them, inside a PostgreSQL integer.
 */
export const MAX_QUANTITY = 1_000_000;

/** A positive whole number of units, as moved by one document line. */
export const quantitySchema = z.number().int().min(1).max(MAX_QUANTITY);

export function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new RangeError(`Quantity must be a whole number from 1 to ${String(MAX_QUANTITY)}`);
  }
}
