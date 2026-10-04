import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CurrencySpec } from '../../src/money/index.js';
import { addMoney, allocate, money, parseDecimal, subMoney } from '../../src/money/index.js';
import { arbMinorUnits, parseFixed, rescale, toFixedString } from './reference.js';

// ISO 4217 reserves XTS/XXX for testing; real specs come from tenant configuration.
const spec = (minorUnits: number, code = 'XTS'): CurrencySpec => ({ code, minorUnits });

describe('money', () => {
  it('formats the amount at the currency scale', () => {
    expect(money('12.5', spec(2))).toEqual({ amount: '12.50', currency: 'XTS' });
    expect(money('12', spec(0))).toEqual({ amount: '12', currency: 'XTS' });
  });

  it('refuses amounts with more decimals than the currency allows (never rounds silently)', () => {
    expect(() => money('1.005', spec(2))).toThrow(RangeError);
  });

  it('refuses to mix currencies', () => {
    const a = money('1', spec(2, 'XTS'));
    const b = money('1', spec(2, 'XXX'));
    expect(() => addMoney(a, b, spec(2, 'XTS'))).toThrow(/currency/i);
    expect(addMoney(a, a, spec(2))).toEqual({ amount: '2.00', currency: 'XTS' });
    expect(subMoney(a, a, spec(2))).toEqual({ amount: '0.00', currency: 'XTS' });
  });
});

describe('allocate', () => {
  it('splits 100.00 three ways without losing a cent', () => {
    const parts = allocate(money('100', spec(2)), ['1', '1', '1'].map(parseDecimal), spec(2));
    expect(parts.map((p) => p.amount)).toEqual(['33.34', '33.33', '33.33']);
  });

  it('handles zero ratios and negative totals', () => {
    const parts = allocate(money('-10', spec(2)), ['0', '1', '3'].map(parseDecimal), spec(2));
    expect(parts.map((p) => p.amount)).toEqual(['0.00', '-2.50', '-7.50']);
  });

  it('rejects empty, negative or all-zero ratios', () => {
    const total = money('1', spec(2));
    expect(() => allocate(total, [], spec(2))).toThrow(RangeError);
    expect(() => allocate(total, ['0', '0'].map(parseDecimal), spec(2))).toThrow(RangeError);
    expect(() => allocate(total, ['1', '-1'].map(parseDecimal), spec(2))).toThrow(RangeError);
  });

  const arbRatios = fc.array(
    fc
      .record({
        units: fc.bigInt({ min: 0n, max: 10n ** 9n }),
        scale: fc.integer({ min: 0, max: 4 }),
      })
      .map(toFixedString),
    { minLength: 1, maxLength: 12 },
  );
  const arbTotal = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

  const arbNonZeroRatios = arbRatios.filter((rs) => rs.some((r) => parseFixed(r).units !== 0n));

  it('parts sum exactly to the total, keep count, and stay within one minor unit of ideal', () => {
    fc.assert(
      fc.property(arbTotal, arbMinorUnits, arbNonZeroRatios, (units, mu, ratios) => {
        const s = spec(mu);
        const total = money(toFixedString({ units, scale: mu }), s);
        const parts = allocate(total, ratios.map(parseDecimal), s);
        expect(parts).toHaveLength(ratios.length);

        const partUnits = parts.map((p) => {
          expect(p.currency).toBe('XTS');
          const f = parseFixed(p.amount);
          expect(f.scale).toBe(mu);
          return f.units;
        });
        expect(partUnits.reduce((a, b) => a + b, 0n)).toBe(units);

        // |part_i - total * r_i / R| < 1 minor unit  <=>  |part_i * R - total * r_i| < R
        const rScale = Math.max(...ratios.map((r) => parseFixed(r).scale));
        const rs = ratios.map((r) => rescale(parseFixed(r), rScale));
        const R = rs.reduce((a, b) => a + b, 0n);
        partUnits.forEach((p, i) => {
          const d = p * R - units * (rs[i] ?? 0n);
          expect((d < 0n ? -d : d) < R).toBe(true);
        });
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(arbTotal, arbNonZeroRatios, (units, ratios) => {
        const total = money(toFixedString({ units, scale: 2 }), spec(2));
        const rs = ratios.map(parseDecimal);
        expect(allocate(total, rs, spec(2))).toEqual(allocate(total, rs, spec(2)));
      }),
    );
  });
});
