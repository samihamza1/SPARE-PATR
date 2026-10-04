import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CurrencySpec, FxRate } from '../../src/money/index.js';
import {
  convert,
  fxRate,
  identityRate,
  money,
  parseDecimal,
  toMonetaryAmount,
} from '../../src/money/index.js';
import { arbMinorUnits, arbMode, parseFixed, refRound, toFixedString } from './reference.js';

// Neutral test codes (ISO 4217 testing/no-currency codes). No real currency is assumed.
const A: CurrencySpec = { code: 'XTS', minorUnits: 2 };
const B: CurrencySpec = { code: 'XXX', minorUnits: 3 };

const arbRate = fc
  .record({
    units: fc.bigInt({ min: 1n, max: 10n ** 12n }),
    scale: fc.integer({ min: 0, max: 10 }),
  })
  .map(toFixedString);

describe('fxRate', () => {
  it('rejects non-positive rates and malformed codes', () => {
    expect(() => fxRate('XTS', 'XXX', '0')).toThrow(RangeError);
    expect(() => fxRate('XTS', 'XXX', '-1')).toThrow(RangeError);
    expect(() => fxRate('xts', 'XXX', '1')).toThrow();
  });

  it('rejects an identity pair whose rate is not 1', () => {
    expect(() => fxRate('XTS', 'XTS', '1.1')).toThrow(RangeError);
    expect(identityRate('XTS')).toEqual({ base: 'XTS', quote: 'XTS', rate: '1' });
  });
});

describe('convert', () => {
  const rate: FxRate = fxRate('XTS', 'XXX', '3.674321');

  it('multiplies in the quoted direction and rounds to the target currency', () => {
    expect(convert(money('10', A), rate, B, 'HALF_EVEN')).toEqual({
      amount: '36.743',
      currency: 'XXX',
    });
  });

  it('divides in the inverse direction', () => {
    expect(convert(money('36.743', B), rate, A, 'HALF_EVEN')).toEqual({
      amount: '10.00',
      currency: 'XTS',
    });
  });

  it('refuses a rate that does not connect the two currencies', () => {
    const other: CurrencySpec = { code: 'XAU', minorUnits: 0 };
    expect(() => convert(money('1', A), rate, other, 'HALF_UP')).toThrow(/rate/i);
  });

  it('is the identity for same-currency conversion at rate 1', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), arbMode, (units, mode) => {
        const m = money(toFixedString({ units, scale: 2 }), A);
        expect(convert(m, identityRate('XTS'), A, mode)).toEqual(m);
      }),
    );
  });

  it('forward conversion equals the oracle rounding of amount * rate', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        arbRate,
        arbMinorUnits,
        arbMode,
        (units, r, mu, mode) => {
          const target: CurrencySpec = { code: 'XXX', minorUnits: mu };
          const fr = parseFixed(r);
          const exact = { units: units * fr.units, scale: 2 + fr.scale };
          const expected = toFixedString(refRound(exact, mu, mode));
          const got = convert(
            money(toFixedString({ units, scale: 2 }), A),
            fxRate('XTS', 'XXX', r),
            target,
            mode,
          );
          expect(got).toEqual({ amount: expected, currency: 'XXX' });
        },
      ),
    );
  });

  it('round trip A -> B -> A stays within the bound implied by rounding', () => {
    // After rounding to B (half unit of B, i.e. 0.5 * 10^-muB), converting back divides that
    // error by the rate, then adds at most half a unit of A. Bound in A units:
    //   |back - original| <= 0.5 * 10^-muB / rate + 0.5 * 10^-muA
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), arbRate, (units, r) => {
        const rate = fxRate('XTS', 'XXX', r);
        const original = money(toFixedString({ units, scale: 2 }), A);
        const there = convert(original, rate, B, 'HALF_EVEN');
        const back = convert(there, rate, A, 'HALF_EVEN');
        const diff = parseFixed(back.amount).units - units; // in 10^-2 units
        const absDiff = diff < 0n ? -diff : diff;
        // 0.5*10^-3/rate in 10^-2 units = 0.05/rate; plus 0.5 → compare scaled by 20*rate:
        // absDiff * 20 * rate <= rate*10 + 1
        const fr = parseFixed(r);
        const lhs = absDiff * 20n * fr.units;
        const rhs = 10n * fr.units + 10n ** BigInt(fr.scale);
        expect(lhs <= rhs).toBe(true);
      }),
    );
  });
});

describe('toMonetaryAmount', () => {
  it('records amount, currency, rate used and functional amount (invariant 2)', () => {
    const rate = fxRate('XTS', 'XXX', '3.674321');
    expect(toMonetaryAmount(money('10', A), rate, B, 'HALF_EVEN')).toEqual({
      amount: '10.00',
      currency: 'XTS',
      fx: { base: 'XTS', quote: 'XXX', rate: '3.674321' },
      functionalAmount: '36.743',
      functionalCurrency: 'XXX',
    });
  });

  it('uses an identity rate for amounts already in the functional currency', () => {
    expect(toMonetaryAmount(money('5', B), identityRate('XXX'), B, 'HALF_EVEN')).toEqual({
      amount: '5.000',
      currency: 'XXX',
      fx: { base: 'XXX', quote: 'XXX', rate: '1' },
      functionalAmount: '5.000',
      functionalCurrency: 'XXX',
    });
  });

  it('accepts decimal-string rates only', () => {
    expect(() => fxRate('XTS', 'XXX', 1.5 as unknown as string)).toThrow(TypeError);
    expect(parseDecimal('1.5')).toBe('1.5');
  });
});
