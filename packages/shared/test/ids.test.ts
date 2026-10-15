import { describe, expect, it } from 'vitest';
import { isUuidV7, newId, uuidSchema, uuidV7Schema } from '../src';

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

describe('uuidV7Schema', () => {
  it('accepts ids from newId() and rejects other UUID versions', () => {
    for (let i = 0; i < 50; i++) expect(isUuidV7(newId())).toBe(true);
    expect(uuidV7Schema.safeParse('3f2c8e1a-5b6d-4c7e-8f90-123456789abc').success).toBe(false);
    expect(uuidV7Schema.safeParse('not-a-uuid').success).toBe(false);
  });
});
