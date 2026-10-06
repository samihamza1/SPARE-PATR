import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutCost } from '../src/inventory/cost-view';
import { canonicalJson, requestHash } from '../src/inventory/idempotency';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('stock moves have one writer (ADR 0020)', () => {
  it('only the engine inserts into stock_moves or stock_documents', () => {
    const writers = sources(SRC)
      .filter((path) =>
        /insertInto\(\s*'(stock_moves|stock_documents)'/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(SRC, path));
    expect(writers).toEqual(['inventory/engine.ts']);
  });
});

describe('request hashing for idempotent documents', () => {
  it('ignores key order and undefined fields, not values or array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
    expect(requestHash({ a: 1, b: '2' }).equals(requestHash({ b: '2', a: 1 }))).toBe(true);
    expect(requestHash({ a: 1 }).equals(requestHash({ a: '1' }))).toBe(false);
    expect(requestHash([1, 2]).equals(requestHash([2, 1]))).toBe(false);
  });
});

describe('cost view', () => {
  it('drops cost from audit snapshots and leaves everything else', () => {
    expect(withoutCost({ quantity: 2, cost: { value: '1.00' } })).toEqual({ quantity: 2 });
    expect(withoutCost(null)).toBeNull();
    expect(withoutCost([{ cost: 1 }])).toEqual([{ cost: 1 }]);
  });
});
