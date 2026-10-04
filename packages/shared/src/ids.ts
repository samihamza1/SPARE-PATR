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

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value);
}

/** For ids a client creates (invariant 5). The database checks the version too. */
export const uuidV7Schema = z.string().refine(isUuidV7, { message: 'id.not_uuid_v7' });
