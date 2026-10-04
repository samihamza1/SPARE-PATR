import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  add,
  compare,
  div,
  isDecimalString,
  isZero,
  mul,
  negate,
  parseDecimal,
  sub,
  sum,
} from '../../src/money/index.js';
import {
  arbDecimalString,
  arbMode,
  parseFixed,
  refRound,
  rescale,
  toFixedString,
} from './reference.js';

const refAdd = (a: string, b: string): string => {
  const fa = parseFixed(a);
  const fb = parseFixed(b);
  const scale = Math.max(fa.scale, fb.scale);
  return toFixedString({ units: rescale(fa, scale) + rescale(fb, scale), scale });
};

/** Numeric equality via the oracle, independent of formatting. */
const sameValue = (a: string, b: string): boolean => {
  const fa = parseFixed(a);
  const fb = parseFixed(b);
  const scale = Math.max(fa.scale, fb.scale);
  return rescale(fa, scale) === rescale(fb, scale);
};

describe('parseDecimal', () => {
  it.each(['0', '1', '-1', '12.5', '0.001', '-0.10', '123456789012345678901234567890.123456789'])(
    'accepts %s',
    (value) => {
      expect(isDecimalString(value)).toBe(true);
      expect(sameValue(parseDecimal(value), value)).toBe(true);
    },
  );

  it.each([
    '',
    ' 1',
    '1 ',
    '+1',
    '1e3',
    '1E-2',
    '.5',
    '5.',
    '01',
    '1,5',
    'NaN',
    'Infinity',
    '--1',
    '0x10',
    '١٢',
  ])('rejects %j', (value) => {
    expect(isDecimalString(value)).toBe(false);
    expect(() => parseDecimal(value)).toThrow();
  });

  it('rejects non-string inputs such as JS numbers', () => {
    expect(() => parseDecimal(1.5 as unknown as string)).toThrow(TypeError);
    expect(isDecimalString(1.5)).toBe(false);
  });

  it('rejects inputs beyond the supported digit count', () => {
    expect(() => parseDecimal('1'.repeat(101))).toThrow();
  });

  it('normalises negative zero', () => {
    expect(parseDecimal('-0')).toBe('0');
    expect(parseDecimal('-0.000')).toBe('0');
  });

  it('round-trips any valid decimal by value', () => {
    fc.assert(fc.property(arbDecimalString(), (s) => sameValue(parseDecimal(s), s)));
  });
});

describe('exact arithmetic (no float drift)', () => {
  it('0.1 + 0.2 = 0.3 exactly', () => {
    expect(add(parseDecimal('0.1'), parseDecimal('0.2'))).toBe('0.3');
  });

  it('add matches the BigInt oracle', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbDecimalString(), (a, b) =>
        sameValue(add(parseDecimal(a), parseDecimal(b)), refAdd(a, b)),
      ),
    );
  });

  it('add is commutative and associative', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbDecimalString(), arbDecimalString(), (a, b, c) => {
        const [x, y, z] = [parseDecimal(a), parseDecimal(b), parseDecimal(c)];
        expect(add(x, y)).toBe(add(y, x));
        expect(add(add(x, y), z)).toBe(add(x, add(y, z)));
      }),
    );
  });

  it('a + b - b = a', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbDecimalString(), (a, b) => {
        const [x, y] = [parseDecimal(a), parseDecimal(b)];
        expect(sub(add(x, y), y)).toBe(x);
      }),
    );
  });

  it('mul matches the BigInt oracle', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbDecimalString(), (a, b) => {
        const fa = parseFixed(a);
        const fb = parseFixed(b);
        const expected = toFixedString({ units: fa.units * fb.units, scale: fa.scale + fb.scale });
        return sameValue(mul(parseDecimal(a), parseDecimal(b)), expected);
      }),
    );
  });

  it('sum of a list equals folded add, and sum([]) = 0', () => {
    expect(sum([])).toBe('0');
    fc.assert(
      fc.property(fc.array(arbDecimalString(), { maxLength: 20 }), (xs) => {
        const ds = xs.map(parseDecimal);
        expect(sum(ds)).toBe(ds.reduce((acc, d) => add(acc, d), parseDecimal('0')));
      }),
    );
  });

  it('negate is an involution and x + (-x) = 0', () => {
    fc.assert(
      fc.property(arbDecimalString(), (a) => {
        const x = parseDecimal(a);
        expect(negate(negate(x))).toBe(x);
        expect(isZero(add(x, negate(x)))).toBe(true);
      }),
    );
  });

  it('compare is consistent with subtraction sign', () => {
    fc.assert(
      fc.property(arbDecimalString(), arbDecimalString(), (a, b) => {
        const [x, y] = [parseDecimal(a), parseDecimal(b)];
        const diff = parseFixed(sub(x, y)).units;
        expect(compare(x, y)).toBe(diff === 0n ? 0 : diff > 0n ? 1 : -1);
      }),
    );
  });
});

describe('div', () => {
  it('requires explicit decimal places and rounding mode', () => {
    expect(div(parseDecimal('10'), parseDecimal('3'), 4, 'HALF_EVEN')).toBe('3.3333');
    expect(div(parseDecimal('2'), parseDecimal('3'), 2, 'DOWN')).toBe('0.66');
    expect(div(parseDecimal('2'), parseDecimal('3'), 2, 'UP')).toBe('0.67');
  });

  it('rejects division by zero', () => {
    expect(() => div(parseDecimal('1'), parseDecimal('0'), 2, 'HALF_UP')).toThrow(RangeError);
  });

  it('(a * b) / b rounds back to a when a fits the requested places', () => {
    fc.assert(
      fc.property(
        arbDecimalString(4),
        arbDecimalString(6).filter((b) => parseFixed(b).units !== 0n),
        arbMode,
        (a, b, mode) => {
          const x = parseDecimal(a);
          const expected = toFixedString(refRound(parseFixed(a), 4, mode));
          expect(div(mul(x, parseDecimal(b)), parseDecimal(b), 4, mode)).toBe(expected);
        },
      ),
    );
  });
});
