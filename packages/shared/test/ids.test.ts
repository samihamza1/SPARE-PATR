import { describe, expect, it } from 'vitest';

import { isUuidV7, newId } from '../src/ids.js';

describe('ids', () => {
  it('generates UUID v7 values that sort by creation time', () => {
    const ids = Array.from({ length: 50 }, newId);
    expect(ids.every(isUuidV7)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects other UUID versions', () => {
    expect(isUuidV7('3f2c8e1a-5b6d-4c7e-8f90-123456789abc')).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
  });
});
