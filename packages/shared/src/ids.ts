import { v7 } from 'uuid';
import { z } from 'zod';

/**
 * Invariant 5: IDs are UUID v7, generated client-side so records can be created offline.
 * v7 is time-ordered, which keeps B-tree inserts local.
 */
export function newId(): string {
  return v7();
}

export const uuidSchema = z.uuid();
