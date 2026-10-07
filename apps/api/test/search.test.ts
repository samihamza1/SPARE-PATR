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

  it('leaves short codes and plain words to the text search', () => {
    expect(values('N70 battery')).toEqual([]);
    expect(interpret('Front Pads, LC').words).toEqual(['front', 'pads', 'lc']);
  });
});
