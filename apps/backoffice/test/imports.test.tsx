import type { ImportBatchDetail, ImportRow } from '@autoparts/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import { ALL, FakeApi, id, me, ok, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BATCH = id(60);

const batch = (overrides: Partial<ImportBatchDetail> = {}): ImportBatchDetail => ({
  id: BATCH,
  fileName: 'stock.xlsx',
  sheet: 'LAND',
  headerRow: 1,
  status: 'previewed',
  mapping: null,
  stats: { rows: 0, byDecision: {}, byIssue: {} },
  createdAt: '2026-10-05T08:00:00.000Z',
  appliedAt: null,
  vehicleCodes: [],
  ...overrides,
});

/** Staged rows 2..n+1 (row 1 holds the titles); every third has a price conflict. */
const stagedRows = (n: number): ImportRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: id(1000 + i),
    rowNumber: i + 2,
    parsed: { partNumber: `P-${String(i + 1)}`, nameEn: `Part ${String(i + 1)}` },
    issues: i % 3 === 0 ? ['price_conflict'] : [],
    decision: 'create',
    skippedByUser: false,
    partId: null,
  }));

/** GET .../rows as the API answers it: filters, then keyset `after` on row number and `limit`. */
const rowsEndpoint = (all: ImportRow[]) => (_body: unknown, query: URLSearchParams) => {
  const after = Number(query.get('after') ?? '0');
  const limit = Number(query.get('limit') ?? '100');
  const issue = query.get('issue');
  return ok(
    all
      .filter((r) => issue === null || r.issues.includes(issue as ImportRow['issues'][number]))
      .filter((r) => r.rowNumber > after)
      .slice(0, limit),
  );
};

const range = (from: number, to: number, total?: number) => {
  const n = (v: number) => new Intl.NumberFormat('ar').format(v);
  return total === undefined
    ? ar.import.rangeOpen.replace('{{from, number}}', n(from)).replace('{{to, number}}', n(to))
    : ar.import.range
        .replace('{{from, number}}', n(from))
        .replace('{{to, number}}', n(to))
        .replace('{{total, number}}', n(total));
};

const previewRows = () => screen.getAllByTestId(/^import-row-/);

describe('import preview', () => {
  it('pages through every staged row and shows where the user is', async () => {
    const all = stagedRows(1200);
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `GET /catalog/imports/${BATCH}`,
        ok(
          batch({
            stats: { rows: 1200, byDecision: { create: 1200 }, byIssue: { price_conflict: 400 } },
          }),
        ),
      )
      .on(`GET /catalog/imports/${BATCH}/rows`, rowsEndpoint(all));
    api.install();
    await renderApp(`/catalog/imports/${BATCH}`);

    await screen.findByText(range(1, 500, 1200));
    expect(previewRows()).toHaveLength(500);
    expect(screen.queryByRole('button', { name: ar.import.previousRows })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ar.import.nextRows }));
    await screen.findByText(range(501, 1000, 1200));
    expect(previewRows()[0]?.dataset.testid).toBe('import-row-502');
    const query = new URLSearchParams(api.calls.at(-1)?.query);
    expect(query.get('after')).toBe('501');

    fireEvent.click(screen.getByRole('button', { name: ar.import.nextRows }));
    await screen.findByText(range(1001, 1200, 1200));
    expect(previewRows()).toHaveLength(200);
    expect(screen.queryByRole('button', { name: ar.import.nextRows })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ar.import.previousRows }));
    await screen.findByText(range(501, 1000, 1200));
    expect(previewRows()[0]?.dataset.testid).toBe('import-row-502');
  });

  it('pages within a filter, counting only the matching rows', async () => {
    const all = stagedRows(1200);
    new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `GET /catalog/imports/${BATCH}`,
        ok(
          batch({
            stats: { rows: 1200, byDecision: { create: 1200 }, byIssue: { price_conflict: 400 } },
          }),
        ),
      )
      .on(`GET /catalog/imports/${BATCH}/rows`, rowsEndpoint(all))
      .install();
    await renderApp(`/catalog/imports/${BATCH}`);
    await screen.findByText(range(1, 500, 1200));
    fireEvent.click(screen.getByRole('button', { name: ar.import.nextRows }));
    await screen.findByText(range(501, 1000, 1200));

    // A filter starts again from its first row.
    const summary = screen.getByRole('group', { name: ar.import.filterByIssue });
    fireEvent.click(within(summary).getByRole('button', { pressed: false }));
    await screen.findByText(range(1, 400, 400));
    expect(previewRows()).toHaveLength(400);
    expect(screen.queryByRole('button', { name: ar.import.nextRows })).toBeNull();
    await waitFor(() => {
      expect(
        previewRows().every((r) => r.textContent.includes(ar.import.issue.price_conflict)),
      ).toBe(true);
    });
  });
});
