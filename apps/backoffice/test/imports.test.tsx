import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS } from '@autoparts/shared';
import type { ImportBatchDetail, ImportRow, Vehicle } from '@autoparts/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import { ALL, CURRENCIES, FakeApi, id, labelled, me, ok, pick, renderApp } from './harness';

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

describe('import wizard', () => {
  async function upload(api: FakeApi) {
    api.install();
    const { container } = await renderApp('/catalog/imports');
    await screen.findByRole('heading', { name: ar.import.title });
    const input = container.querySelector('input[type=file]');
    if (input === null) throw new Error('no file input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['xlsx'], 'stock.xlsx')] } });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.read }));
  }
  const sheets = {
    sheets: [
      { name: 'BIG', rowCount: 0, columnCount: 0, rows: [], tooLarge: true },
      {
        name: 'LAND',
        rowCount: 3,
        columnCount: 2,
        rows: [
          ['DEMO', null],
          ['Part', 'Name'],
          ['A-1', 'Filter'],
        ],
        tooLarge: false,
      },
    ],
  };
  const lookups = (permissions = ALL) =>
    new FakeApi()
      .on('GET /auth/me', ok(me(permissions)))
      .on('GET /catalog/price-lists', ok([]))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /catalog/imports', ok([]))
      .on('POST /catalog/imports/inspect', ok(sheets))
      .on('POST /catalog/imports', { status: 201, body: { id: BATCH } })
      .on(`GET /catalog/imports/${BATCH}`, ok(batch()))
      .on(`GET /catalog/imports/${BATCH}/rows`, ok([]));

  it('lists a sheet past the limits but starts on the first sheet it can read', async () => {
    await upload(lookups());
    const sheet = await screen.findByLabelText(labelled(ar.import.sheet), { selector: 'input' });
    await waitFor(() => {
      expect((sheet as HTMLInputElement).value).toBe(
        `LAND (${ar.import.rows.replace('{{count}}', '3')})`,
      );
    });
    await userEvent.setup().click(sheet);
    const n = (v: number) => new Intl.NumberFormat('ar').format(v);
    const big = await screen.findByRole('option', {
      name: ar.import.sheetTooLarge
        .replace('{{name}}', 'BIG')
        .replace('{{rows, number}}', n(IMPORT_MAX_ROWS))
        .replace('{{columns, number}}', n(IMPORT_MAX_COLUMNS)),
    });
    expect(big.getAttribute('data-combobox-disabled')).toBe('true');
  });

  it('takes the header row from its number field, without a mouse', async () => {
    const api = lookups();
    await upload(api);
    const header = await screen.findByLabelText(labelled(ar.import.headerRow), {
      selector: 'input',
    });
    fireEvent.change(header, { target: { value: '2' } });
    await waitFor(() => {
      expect(screen.getByTestId('sheet-row-2').getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.next }));
    await pick(ar.import.field.partNumber, 'A — Part');
    await pick(ar.import.field.nameEn, 'B — Name');
    await pick(ar.import.numberKind, ar.catalog.numberKind.oem);
    fireEvent.change(screen.getByLabelText(labelled(ar.import.skuPrefix), { selector: 'input' }), {
      target: { value: 'SKY' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.stage }));
    await waitFor(() => {
      const staged = api.calls.find((c) => c.method === 'POST' && c.path === '/catalog/imports');
      expect(staged?.body).toMatchObject({ sheet: 'LAND', headerRow: 2 });
    });
  });

  it('offers the selling-price column only to users who may change prices', async () => {
    await upload(lookups(ALL.filter((p) => p !== 'prices.manage')));
    fireEvent.click(await screen.findByRole('button', { name: ar.import.next }));
    await screen.findByLabelText(labelled(ar.import.field.partNumber), { selector: 'input' });
    expect(
      screen.queryByLabelText(labelled(ar.import.field.sellPrice), { selector: 'input' }),
    ).toBeNull();
  });
});

describe('mapping a vehicle code', () => {
  const vehicle = (n: number, name: string): Vehicle => ({
    id: id(n),
    parentId: null,
    level: 'model',
    name,
    nameAr: null,
    yearFrom: 2008,
    yearTo: null,
    engineCode: null,
    displacementCc: null,
    fuel: null,
    isLocal: false,
    archivedAt: null,
  });

  it('retries only the vehicles that were not saved, and refreshes the preview', async () => {
    const lc200 = vehicle(91, 'Land Cruiser 200');
    const lc300 = vehicle(92, 'Land Cruiser 300');
    let failSecond = true;
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `GET /catalog/imports/${BATCH}`,
        ok(
          batch({
            status: 'draft',
            stats: { rows: 1, byDecision: { create: 1 }, byIssue: { vehicle_unmapped: 1 } },
            vehicleCodes: [{ code: 'LC', codeNorm: 'lc', rows: 1, mapping: null }],
          }),
        ),
      )
      .on(`GET /catalog/imports/${BATCH}/rows`, ok([]))
      .on('GET /catalog/categories', ok([]))
      .on('GET /catalog/vehicles', (_b, q) =>
        ok([lc200, lc300].filter((v) => v.name.endsWith(q.get('q') ?? ''))),
      )
      .on('POST /catalog/vehicle-aliases', (body) => {
        const vehicleId = (body as { vehicleId: string }).vehicleId;
        if (vehicleId === lc300.id && failSecond) {
          failSecond = false;
          return { status: 500, body: { error: { code: 'internal' } } };
        }
        return { status: 201, body: {} };
      })
      .on(`POST /catalog/imports/${BATCH}/analyse`, ok(batch({ status: 'previewed' })));
    api.install();
    await renderApp(`/catalog/imports/${BATCH}`);
    fireEvent.click(
      within(await screen.findByTestId('code-lc')).getByRole('button', {
        name: ar.import.mapCode,
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: ar.import.mapCodeTitle.replace('{{code}}', 'LC'),
    });
    const user = userEvent.setup();
    for (const [typed, v] of [
      ['200', lc200],
      ['300', lc300],
    ] as const) {
      const input = within(dialog).getByLabelText(ar.catalog.chooseVehicle, { selector: 'input' });
      await user.type(input, typed);
      await user.click(await screen.findByRole('option', { name: new RegExp(v.name) }));
    }
    // A picked vehicle can be removed with a labelled button.
    expect(
      within(dialog).getByRole('button', {
        name: ar.common.removeNamed.replace('{{name}}', lc300.name),
      }),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await within(dialog).findByText(ar.import.mapSaved.replace('{{names}}', lc200.name));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.path === `/catalog/imports/${BATCH}/analyse`)).toBe(true);
    });
    const posted = api.calls
      .filter((c) => c.path === '/catalog/vehicle-aliases')
      .map((c) => (c.body as { vehicleId: string }).vehicleId);
    expect(posted).toEqual([lc200.id, lc300.id, lc300.id]);
  });
});
