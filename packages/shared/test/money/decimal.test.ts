import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dec, formatFixed, toDecimalString } from '../../src/money';
import { decimalArb, unitsToDecimalString } from './arbitraries';

describe('dec', () => {
  it.each([
    '0',
    '-0',
    '1',
    '-1',
    '10.50',
    '0.000000001',
    '123456789012345678901234567890.123456789',
  ])('accepts canonical decimal string %s', (input) => {
    expect(() => dec(input)).not.toThrow();
  });

  it.each([
    '',
    ' 1',
    '1 ',
    '+1',
    '1.',
    '.5',
    '1e5',
    '1E-5',
    'NaN',
    'Infinity',
    '-',
    '0x10',
    '1,5',
    '01',
  ])('rejects malformed decimal string %j', (input) => {
    expect(() => dec(input)).toThrow(TypeError);
  });

  const nonStrings: unknown[] = [1.5, 0, Number.NaN, 10n, null, undefined, {}];
  it.each(nonStrings)('rejects non-string input %s at runtime', (input) => {
    expect(() => dec(input as string)).toThrow(TypeError);
  });
});

describe('toDecimalString', () => {
  it('normalises negative zero to "0"', () => {
    expect(toDecimalString(dec('-0'))).toBe('0');
    expect(toDecimalString(dec('-0.000'))).toBe('0');
  });

  it('round-trips any decimal string exactly (property)', () => {
    fc.assert(
      fc.property(decimalArb({ maxScale: 30, maxUnits: 10n ** 40n }), (s) => {
        const out = toDecimalString(dec(s));
        expect(dec(out).eq(dec(s))).toBe(true);
      }),
    );
  });

  it('never produces exponent notation, even for tiny or huge values (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 45n), max: 10n ** 45n }),
        fc.integer({ min: 0, max: 40 }),
        (units, scale) => {
          const out = toDecimalString(dec(unitsToDecimalString(units, scale)));
          expect(out).not.toMatch(/e/i);
          expect(out).toMatch(/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/);
        },
      ),
    );
  });
});

describe('formatFixed', () => {
  it('pads to exactly the requested scale', () => {
    expect(formatFixed(dec('1.5'), 2)).toBe('1.50');
    expect(formatFixed(dec('7'), 3)).toBe('7.000');
    expect(formatFixed(dec('7'), 0)).toBe('7');
    expect(formatFixed(dec('-0'), 2)).toBe('0.00');
  });

  it('refuses to silently round', () => {
    expect(() => formatFixed(dec('1.005'), 2)).toThrow(RangeError);
  });
});
