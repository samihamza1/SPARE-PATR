import { describe, expect, it } from 'vitest';
import { newId, uuidSchema } from '../src';

describe('newId', () => {
  it('generates RFC 9562 UUID v7 values', () => {
    const id = newId();
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(id[14]).toBe('7');
  });

  it('is unique and time-ordered when generated in sequence', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
