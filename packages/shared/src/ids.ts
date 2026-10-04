import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

/**
 * IDs are UUID v7, generated client-side so that rows can be created offline
 * (CLAUDE.md invariant 5). The database only checks the version.
 */
export const newId = (): string => uuidv7();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuidV7 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V7.test(value);

export const UuidV7Schema = z.string().refine(isUuidV7, { message: 'Expected a UUID v7' });
