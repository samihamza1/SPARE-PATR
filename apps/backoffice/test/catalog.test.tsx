import type { ImportBatchDetail, ImportRow, SearchResult, Vehicle } from '@autoparts/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import { ALL, FakeApi, id, me, part, pick, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('salesperson search', () => {
  it('shows each result with its alternatives in the order the API ranked them', async () => {
    const result: SearchResult = {
      interpretation: {
        text: ['فحمات'],
        year: 2015,
        partNumber: null,
        vehicles: [{ id: id(90), name: 'Land Cruiser', level: 'model' }],
      },
      results: [
        {
          part: part(1, 'BP-OEM', 'oem', 'فحمات أمامية'),
          price: { amount: '85.00', currency: 'AAA' },
          matchedBy: 'text',
          alternatives: [
            {
              part: part(2, 'BP-PRM', 'premium', 'فحمات ممتازة'),
              price: { amount: '60.00', currency: 'AAA' },
              relation: 'interchange',
            },
            {
              part: part(3, 'BP-UNG', null, 'فحمات'),
              price: null,
              relation: 'shared_number',
            },
          ],
        },
      ],
    };
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: me([]) })
      .on('GET /catalog/search', { status: 200, body: result });
    api.install();
    await renderApp('/search');
    const box = await screen.findByRole('textbox', { name: ar.search.title });
    fireEvent.change(box, { target: { value: 'فحمات امامية لاندكروزر 2015' } });
    fireEvent.click(screen.getByRole('button', { name: ar.search.submit }));

    const card = await screen.findByTestId('search-result');
    expect(card.textContent).toContain('BP-OEM');
    expect(card.textContent).toContain('85.00 AAA');
    expect(card.textContent).toContain(ar.catalog.gradeLabel.oem);
    const alternatives = within(card).getAllByTestId('alternative');
    expect(alternatives.map((r) => r.textContent)).toEqual([
      expect.stringContaining('BP-PRM'),
      expect.stringContaining('BP-UNG'),
    ]);
    expect(alternatives[0]?.textContent).toContain(ar.catalog.relation.interchange);
    expect(alternatives[1]?.textContent).toContain(ar.catalog.gradeLabel.none);
    expect(alternatives[1]?.textContent).toContain(ar.catalog.noPrice);
    expect(screen.getByText(ar.search.year.replace('{{year}}', '2015'))).toBeTruthy();
    expect(new URLSearchParams(api.calls.at(-1)?.query).get('q')).toBe(
      'فحمات امامية لاندكروزر 2015',
    );
  });
});

describe('parts', () => {
  it('filters the "needs review" list and grades the selected parts together', async () => {
    const parts = [part(1, 'SKY-00001', null, 'مصفي زيت'), part(2, 'SKY-00002', null, 'فحمات')];
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on('GET /catalog/parts', { status: 200, body: parts })
      .on('POST /catalog/parts/bulk-update', { status: 200, body: { updated: 2 } });
    api.install();
    await renderApp('/catalog/parts');
    await screen.findByText('SKY-00001');
    fireEvent.click(screen.getByText(ar.catalog.needsReview.ungraded));
    await waitFor(() => {
      expect(api.calls.some((c) => c.query.includes('needsReview=ungraded'))).toBe(true);
    });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'SKY-00001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'SKY-00002' }));
    await pick(ar.catalog.bulkGrade, ar.catalog.gradeLabel.good);
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.bulkApply }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.path === '/catalog/parts/bulk-update')?.body).toEqual({
        ids: [id(1), id(2)],
        set: { qualityGrade: 'good' },
      });
    });
  });

  it('lets a cashier read the catalog but not import or edit it', async () => {
    new FakeApi()
      .on('GET /auth/me', { status: 200, body: me([]) })
      .on('GET /catalog/parts', { status: 200, body: [part(1, 'SKY-00001', 'oem', 'مصفي')] })
      .install();
    await renderApp('/catalog/parts');
    await screen.findByText('SKY-00001');
    expect(screen.queryByRole('button', { name: ar.catalog.newPart })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    cleanup();
    new FakeApi().on('GET /auth/me', { status: 200, body: me([]) }).install();
    await renderApp('/catalog/imports');
    expect((await screen.findByRole('alert')).textContent).toContain(ar.errors.auth.forbidden);
  });
});

describe('import wizard', () => {
  const owner = me(ALL);
  const lists = [
    { id: id(50), name: 'Retail', currency: 'AAA', isDefault: true, archivedAt: null },
  ];

  it('reads the file, takes the header row and column mapping, and stages the import', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: owner })
      .on('GET /catalog/price-lists', { status: 200, body: lists })
      .on('GET /currencies', { status: 200, body: [] })
      .on('GET /catalog/imports', { status: 200, body: [] })
      .on('POST /catalog/imports/inspect', {
        status: 200,
        body: {
          sheets: [
            {
              name: 'LAND',
              rowCount: 3,
              columnCount: 3,
              rows: [
                ['DEMO CATALOG', null, null],
                ['Part', 'Name', 'Price'],
                ['A-1', 'Filter', '10'],
              ],
              tooLarge: false,
            },
          ],
        },
      })
      .on('POST /catalog/imports', { status: 201, body: { id: id(60) } })
      .on(`GET /catalog/imports/${id(60)}`, {
        status: 404,
        body: { error: { code: 'resource.not_found' } },
      })
      .on(`GET /catalog/imports/${id(60)}/rows`, { status: 200, body: [] });
    api.install();
    const { container } = await renderApp('/catalog/imports');
    await screen.findByRole('heading', { name: ar.import.title });

    const input = container.querySelector('input[type=file]');
    if (input === null) throw new Error('no file input');
    const file = new File(['xlsx bytes'], 'stock.xlsx');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.read }));
    fireEvent.click(await screen.findByTestId('sheet-row-2'));
    expect(api.calls.find((c) => c.path === '/catalog/imports/inspect')?.body).toEqual({
      fileName: 'stock.xlsx',
      contentBase64: btoa('xlsx bytes'),
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.next }));

    await pick(ar.import.field.partNumber, 'A — Part');
    await pick(ar.import.field.nameEn, 'B — Name');
    await pick(ar.import.field.sellPrice, 'C — Price');
    await pick(ar.import.numberKind, ar.catalog.numberKind.oem);
    await pick(ar.import.priceList, 'Retail (AAA)');
    fireEvent.change(
      screen.getByLabelText(ar.import.skuPrefix, { selector: 'input', exact: false }),
      {
        target: { value: 'sky' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: ar.import.stage }));
    await waitFor(() => {
      expect(
        api.calls.find((c) => c.method === 'POST' && c.path === '/catalog/imports')?.body,
      ).toEqual({
        id: expect.any(String) as string,
        fileName: 'stock.xlsx',
        contentBase64: btoa('xlsx bytes'),
        sheet: 'LAND',
        headerRow: 2,
        mapping: {
          columns: { partNumber: 0, nameEn: 1, sellPrice: 2 },
          numberKind: 'oem',
          priceListId: id(50),
          costCurrency: null,
          skuPrefix: 'SKY',
        },
      });
    });
  });

  it('maps a vehicle code, previews and applies', async () => {
    const vehicle: Vehicle = {
      id: id(90),
      parentId: id(89),
      level: 'model',
      name: 'Land Cruiser',
      nameAr: 'لاندكروزر',
      yearFrom: null,
      yearTo: null,
      engineCode: null,
      displacementCc: null,
      fuel: null,
      isLocal: false,
      archivedAt: null,
    };
    let detail: ImportBatchDetail = {
      id: id(60),
      fileName: 'stock.xlsx',
      sheet: 'LAND',
      headerRow: 2,
      status: 'draft',
      mapping: null,
      stats: { rows: 2, byDecision: { create: 2 }, byIssue: { vehicle_unmapped: 2 } },
      createdAt: '2026-10-05T08:00:00.000Z',
      appliedAt: null,
      vehicleCodes: [{ code: 'LC', codeNorm: 'lc', rows: 2, mapping: null }],
    };
    const rows: ImportRow[] = [
      {
        id: id(61),
        rowNumber: 3,
        parsed: { partNumber: 'A-1', nameEn: 'Filter', vehicleCode: 'LC', sellPrice: '10.00' },
        issues: ['vehicle_unmapped'],
        decision: 'create',
        skippedByUser: false,
        partId: null,
      },
    ];
    vi.stubGlobal('confirm', () => true);
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on(`GET /catalog/imports/${id(60)}`, () => ({ status: 200, body: detail }))
      .on(`GET /catalog/imports/${id(60)}/rows`, { status: 200, body: rows })
      .on('GET /catalog/categories', { status: 200, body: [] })
      .on('GET /catalog/vehicles', { status: 200, body: [vehicle] })
      .on('POST /catalog/vehicle-aliases', { status: 201, body: {} })
      .on(`POST /catalog/imports/${id(60)}/analyse`, () => {
        detail = {
          ...detail,
          status: 'previewed',
          stats: { rows: 2, byDecision: { create: 2 }, byIssue: {} },
          vehicleCodes: [
            {
              code: 'LC',
              codeNorm: 'lc',
              rows: 2,
              mapping: {
                target: 'vehicle',
                vehicles: [{ id: id(90), name: 'Land Cruiser' }],
                categoryId: null,
              },
            },
          ],
        };
        return { status: 200, body: detail };
      })
      .on(`POST /catalog/imports/${id(60)}/apply`, () => {
        detail = {
          ...detail,
          status: 'applied',
          stats: {
            rows: 2,
            byDecision: { create: 2 },
            byIssue: {},
            pricesSet: 2,
            fitmentsAdded: 2,
          },
        };
        return { status: 200, body: detail };
      });
    api.install();
    await renderApp(`/catalog/imports/${id(60)}`);
    await screen.findByText(`${ar.import.issue.vehicle_unmapped}: 2`);

    fireEvent.click(
      within(screen.getByTestId('code-lc')).getByRole('button', { name: ar.import.mapCode }),
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(ar.catalog.chooseVehicle, { selector: 'input' }),
      'land',
    );
    await user.click(await screen.findByRole('option', { name: /Land Cruiser/ }));
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.path === '/catalog/vehicle-aliases')?.body).toEqual({
        id: expect.any(String) as string,
        alias: 'LC',
        target: 'vehicle',
        vehicleId: id(90),
      });
    });
    await screen.findByText(ar.import.status.previewed);

    fireEvent.click(screen.getByRole('button', { name: ar.import.apply }));
    await screen.findByText(ar.import.status.applied);
    expect(screen.getByText(new RegExp(`${ar.import.pricesSet}: 2`))).toBeTruthy();
  });
});
