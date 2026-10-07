import { performance } from 'node:perf_hooks';
import type { SearchResult } from '@autoparts/shared';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SyntheticPart } from '../../src/catalog/synthetic';
import { seedSyntheticCatalog } from '../../src/catalog/synthetic';
import type { Client } from '../integration/harness';
import { MINUTE, loggedIn, provisionShop, setupEnv } from '../integration/harness';

/**
 * p95 of GET /catalog/search under 200 ms on 50,000 synthetic parts (Sprint 3 target),
 * measured through the whole stack: HTTP, session, RLS transaction, queries.
 */
const PARTS = Number.parseInt(process.env.PERF_PARTS ?? '50000', 10);
const RUNS_PER_KIND = 60;
const TARGET_P95_MS = 200;

const env = setupEnv();
let client: Client;
let parts: SyntheticPart[];

beforeAll(async () => {
  const shop = await provisionShop(env);
  const started = performance.now();
  ({ parts } = await seedSyntheticCatalog(env.appDb, shop.tenantId, {
    parts: PARTS,
    currency: 'AAA',
    minorUnits: 2,
    // In effect before the test clock, or no result would ever carry a price.
    effectiveAt: new Date(env.clock.now.getTime() - MINUTE),
  }));
  await sql`ANALYZE parts, part_numbers, fitments, part_prices, vehicles, interchange_members`.execute(
    env.ownerDb,
  );
  console.log(`seeded ${String(PARTS)} parts in ${(performance.now() - started).toFixed(0)} ms`);
  client = await loggedIn(env, shop);
});

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

describe('catalog search performance', () => {
  it(`keeps p95 under ${String(TARGET_P95_MS)} ms on ${String(PARTS)} parts`, async () => {
    const sample = (i: number): SyntheticPart => {
      const part = parts[(i * 7919) % parts.length];
      if (part === undefined) throw new Error('no synthetic parts');
      return part;
    };
    const kinds: Record<string, (p: SyntheticPart) => string> = {
      'name + vehicle + year': (p) =>
        `${p.nameEn} ${p.vehicle.modelName} ${String(p.vehicle.yearFrom + 3)}`,
      'exact number': (p) => p.number,
      'number prefix': (p) => p.number.slice(0, 7),
      'name only': (p) => p.nameEn,
    };
    const timings: number[] = [];
    const report: Record<string, { p50: number; p95: number; max: number }> = {};
    // Warm-up (connection pool, plans).
    for (let i = 0; i < 10; i++)
      await client.get(`/catalog/search?q=${encodeURIComponent(sample(i).number)}`);

    for (const [kind, query] of Object.entries(kinds)) {
      const own: number[] = [];
      for (let i = 0; i < RUNS_PER_KIND; i++) {
        const part = sample(i + 100);
        const started = performance.now();
        const res = await client.get(`/catalog/search?q=${encodeURIComponent(query(part))}`);
        own.push(performance.now() - started);
        expect(res.statusCode).toBe(200);
        if (kind === 'exact number') {
          const hit = res.json<SearchResult>().results.find((r) => r.part.id === part.id);
          expect(hit).toBeDefined();
          // Prices are part of what is measured (lookup, formatting, ordering).
          expect(hit?.price).not.toBeNull();
        }
      }
      own.sort((a, b) => a - b);
      report[kind] = {
        p50: Math.round(percentile(own, 50)),
        p95: Math.round(percentile(own, 95)),
        max: Math.round(own.at(-1) ?? 0),
      };
      timings.push(...own);
    }
    timings.sort((a, b) => a - b);
    const p95 = percentile(timings, 95);
    console.table(report);
    console.log(`overall p50 ${percentile(timings, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(TARGET_P95_MS);
  });
});
