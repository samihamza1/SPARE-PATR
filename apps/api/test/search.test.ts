import { describe, expect, it } from 'vitest';
import { interpret } from '../src/catalog/search';

const values = (q: string) => interpret(q).numbers.map((n) => [n.value, n.exactOnly]);

describe('interpret: part-number candidates (ADR 0015 addendum)', () => {
  it('keeps a dashed number whole next to a word, on either side', () => {
    expect(values('فحمات 04465-60320')).toEqual([['0446560320', false]]);
    expect(values('04465-60320 فحمات')).toEqual([['0446560320', false]]);
  });

  it('joins adjacent number tokens, longest first, without the words around them', () => {
    expect(values('pads 04465 60320')).toEqual([
      ['0446560320', false],
      ['04465', false],
      ['60320', false],
    ]);
  });

  it('matches a year-like token only exactly, unless it is the whole query', () => {
    expect(values('04465 60320 2015')).toEqual([
      ['0446560320', false],
      ['04465', false],
      ['60320', false],
      ['2015', true],
    ]);
    expect(values('2015')).toEqual([['2015', false]]);
  });

  it('joins short letter groups printed apart from the digits (W 712/75, HU 7008 z)', () => {
    expect(values('W 712/75')[0]).toEqual(['W71275', false]);
    expect(values('HU 7008 z')[0]).toEqual(['HU7008Z', false]);
    expect(values('F 026 407 006')[0]).toEqual(['F026407006', false]);
    expect(values('A 271 180 00 09')[0]).toEqual(['A2711800009', false]);
    expect(values('pads W 712/75')[0]).toEqual(['W71275', false]);
    // Longer words never join, and a candidate always has a digit.
    expect(values('pads 04465 60320')[0]).toEqual(['0446560320', false]);
    expect(values('AB CD 1234').map(([v]) => v)).not.toContain('ABCD');
  });

  it('leaves short codes and plain words to the text search', () => {
    expect(values('N70 battery')).toEqual([]);
    expect(interpret('Front Pads, LC').words).toEqual(['front', 'pads', 'lc']);
  });
});
