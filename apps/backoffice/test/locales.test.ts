import { PERMISSIONS } from '@autoparts/shared';
import { describe, expect, it } from 'vitest';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';

function keys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function values(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return [node];
  return Object.values(node).flatMap(values);
}

describe('locales', () => {
  it('Arabic and English define the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it('has no empty translations', () => {
    for (const value of [...values(ar), ...values(en)]) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
  });

  it('labels every permission in both languages', () => {
    for (const locale of [ar, en]) {
      const labels = keys(locale.permissions);
      expect(labels.sort()).toEqual([...PERMISSIONS].sort());
    }
  });
});
