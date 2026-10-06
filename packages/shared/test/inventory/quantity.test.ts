import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_QUANTITY, assertQuantity, quantitySchema } from '../../src/inventory';

describe('quantities are whole units', () => {
  it('accepts whole numbers from 1 to the maximum', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_QUANTITY }), (q) => {
        expect(quantitySchema.safeParse(q).success).toBe(true);
        expect(() => {
          assertQuantity(q);
        }).not.toThrow();
      }),
    );
  });

  it.each([0, -1, 1.5, 0.1, MAX_QUANTITY + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s',
    (q) => {
      expect(quantitySchema.safeParse(q).success).toBe(false);
      expect(() => {
        assertQuantity(q);
      }).toThrow(RangeError);
    },
  );

  it('rejects quantities sent as strings', () => {
    expect(quantitySchema.safeParse('2').success).toBe(false);
  });
});
