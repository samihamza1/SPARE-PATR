import type { z } from 'zod';

/**
 * A PATCH body must set at least one field. Fields are optional, so `{}` would otherwise
 * pass and reach the database as an UPDATE with nothing to set.
 */
export function requireChange<T extends z.ZodType<object>>(schema: T): T {
  return schema.refine((v) => Object.keys(v).length > 0, { message: 'update.nothing_to_set' });
}
