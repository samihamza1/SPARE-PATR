import type {
  CountLine,
  CurrentFxRates,
  OpeningDraft,
  OpeningLine,
  PartStock,
  ReviewItem,
  StockCount,
} from '@autoparts/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import {
  CURRENCIES,
  FakeApi,
  LOCATIONS,
  id,
  labelled,
  me,
  ok,
  onPartPage,
  part,
  partDetail,
  pick,
  renderApp,
} from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const shop = LOCATIONS[0]?.id ?? '';
const BBB = { ...CURRENCIES[0]!, id: id(401), code: 'BBB', isFunctional: false };

describe('exchange rates (ADR 0019)', () => {
  it('records a rate as the market quotes it, and says when today has none', async () => {
    const current: CurrentFxRates = {
      businessDate: '2026-10-07',
      functionalCurrency: 'AAA',
      rates: [{ currency: 'BBB', rate: null, enteredToday: false }],
    };
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['fx.manage'])))
      .on('GET /currencies', ok([...CURRENCIES, BBB]))
      .on('GET /fx-rates/current', ok(current))
      .on('GET /fx-rates', ok([]))
      .on('POST /fx-rates', { status: 201, body: {} });
    api.install();
    await renderApp('/fx-rates');
    expect((await screen.findByRole('status')).textContent).toContain(ar.fx.missingTodayTitle);

    // "1 [AAA] = [3.6725] [BBB]": the functional currency is preset on the left.
    await pick(ar.fx.quoteCurrency, 'BBB');
    fireEvent.change(screen.getByRole('textbox', { name: ar.fx.rate }), {
      target: { value: '3.6725' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.fx.save }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        id: expect.any(String) as string,
        base: 'AAA',
        quote: 'BBB',
        rate: '3.6725',
      });
    });
  });
});

describe('stock card on the part page (ADR 0022)', () => {
  const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'));
  const stock = (withCost: boolean): PartStock => ({
    partId: detail.id,
    total: 5,
    locations: [{ locationId: shop, quantity: 5, lastInAt: null, lastOutAt: null }],
    ...(withCost && {
      cost: { value: '50.00', averageCost: '10.00', currency: 'AAA' },
    }),
  });

  it('shows quantities to everyone, and value and average only when the API sends them', async () => {
    onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me([])))
      .on(`GET /stock/parts/${detail.id}`, ok(stock(false)))
      .install();
    await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByText(ar.inventory.total);
    expect(screen.queryByText(ar.inventory.value)).toBeNull();
    expect(screen.queryByText(ar.inventory.averageCost)).toBeNull();
    cleanup();

    onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(['cost.view'])))
      .on(`GET /stock/parts/${detail.id}`, ok(stock(true)))
      .install();
    await renderApp(`/catalog/parts/${detail.id}`);
    expect(await screen.findByText(ar.inventory.value)).toBeTruthy();
    expect(screen.getByText(ar.inventory.averageCost)).toBeTruthy();
  });
});

describe('adjustments (ADR 0025)', () => {
  const filter = part(1, 'SKY-1', null, 'فلتر');
  const setup = () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['stock.adjust'])))
      .on(`GET /catalog/parts/${filter.id}`, ok(filter))
      .on('GET /locations', ok(LOCATIONS))
      .on('GET /currencies', ok(CURRENCIES))
      .on('POST /stock/adjustments', ok({ id: id(500), moves: [{}] }));
    api.install();
    return api;
  };
  const posted = (api: FakeApi) =>
    api.calls.find((c) => c.method === 'POST' && c.path === '/stock/adjustments')?.body;

  it('sends units leaving stock as negative, whatever the user typed', async () => {
    const api = setup();
    await renderApp(`/inventory/adjust?part=${filter.id}`);
    await screen.findByText('SKY-1');
    await pick(ar.inventory.location, 'المحل');
    await pick(ar.inventory.reasonLabel, ar.inventory.reason.damaged);
    fireEvent.change(screen.getByRole('textbox', { name: ar.inventory.quantity }), {
      target: { value: '3' },
    });
    // No cost for units leaving stock.
    expect(screen.queryByRole('textbox', { name: ar.inventory.unitCost })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ar.inventory.postAdjustment }));
    await waitFor(() => {
      expect(posted(api)).toMatchObject({
        locationId: shop,
        reason: 'damaged',
        lines: [{ partId: filter.id, quantity: -3 }],
      });
    });
  });

  it('takes a unit cost for units found', async () => {
    const api = setup();
    await renderApp(`/inventory/adjust?part=${filter.id}`);
    await screen.findByText('SKY-1');
    await pick(ar.inventory.location, 'المحل');
    fireEvent.change(screen.getByRole('textbox', { name: ar.inventory.quantity }), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: ar.inventory.unitCost }), {
      target: { value: '12.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.inventory.postAdjustment }));
    await waitFor(() => {
      expect(posted(api)).toMatchObject({
        reason: 'found',
        lines: [{ partId: filter.id, quantity: 2, unitCost: { amount: '12.50', currency: 'AAA' } }],
      });
    });
  });
});

describe('opening stock (ADR 0024)', () => {
  const draft = (counts: OpeningDraft['counts']): OpeningDraft => ({
    id: id(71),
    batchId: id(60),
    fileName: 'stock.xlsx',
    locationId: shop,
    asOf: '2026-10-07',
    costCurrency: 'AAA',
    functionalCurrency: 'AAA',
    fxRate: null,
    status: 'draft',
    counts,
    totals: { quantity: 10, amount: '100', functionalAmount: '100.00' },
    postedAt: null,
  });
  const show = async (counts: OpeningDraft['counts']) => {
    new FakeApi()
      .on('GET /auth/me', ok(me(['stock.opening', 'cost.view'])))
      .on('GET /locations', ok(LOCATIONS))
      .on('GET /currencies', ok(CURRENCIES))
      .on(
        'GET /fx-rates/current',
        ok({ businessDate: '2026-10-07', functionalCurrency: 'AAA', rates: [] }),
      )
      .on(`GET /stock/opening/${id(71)}`, ok(draft(counts)))
      .on(`GET /stock/opening/${id(71)}/lines`, ok([]))
      .install();
    await renderApp(`/inventory/opening/${id(71)}`);
    return screen.findByRole('button', { name: ar.opening.post });
  };

  it('cannot be posted while a line needs a cost', async () => {
    const post = await show({ ready: 4, needs_cost: 1, needs_quantity: 0, excluded: 2 });
    expect(post.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(ar.opening.notReady)).toBeTruthy();
  });

  it('can be posted once every line is ready or excluded', async () => {
    const post = await show({ ready: 5, needs_cost: 0, needs_quantity: 0, excluded: 2 });
    expect(post.hasAttribute('disabled')).toBe(false);
  });

  const counts = { ready: 0, needs_cost: 150, needs_quantity: 0, excluded: 0 };
  const line = (n: number): OpeningLine => ({
    partId: id(1000 + n),
    sku: `SKU-${String(n).padStart(4, '0')}`,
    nameAr: null,
    nameEn: `Part ${String(n)}`,
    rows: 1,
    fileQuantity: '1',
    quantity: 1,
    amount: null,
    unitCost: null,
    costSource: null,
    suggestedUnitCost: null,
    status: 'needs_cost',
    exclusion: null,
  });
  const fake = () =>
    new FakeApi()
      .on('GET /auth/me', ok(me(['stock.opening', 'cost.view'])))
      .on('GET /locations', ok(LOCATIONS))
      .on('GET /currencies', ok(CURRENCIES))
      .on(
        'GET /fx-rates/current',
        ok({ businessDate: '2026-10-07', functionalCurrency: 'AAA', rates: [] }),
      )
      .on(`GET /stock/opening/${id(71)}`, ok(draft(counts)));

  it('saves the go-live date once it is fully entered, not at every keystroke', async () => {
    const api = fake()
      .on(`GET /stock/opening/${id(71)}/lines`, ok([]))
      .on(`PATCH /stock/opening/${id(71)}`, (body) =>
        ok({ ...draft(counts), ...(body as object) }),
      );
    api.install();
    await renderApp(`/inventory/opening/${id(71)}`);
    const date = await screen.findByLabelText(ar.opening.asOf);
    // A date input reports each typed digit of the year as a whole date.
    for (const value of ['0002-10-05', '0020-10-05', '0202-10-05', '2026-10-05']) {
      fireEvent.change(date, { target: { value } });
    }
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    fireEvent.blur(date);
    await waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { asOf: '2026-10-05' },
      ]);
    });
  });

  it('pages through the lines of a tab, by SKU', async () => {
    const api = fake().on(`GET /stock/opening/${id(71)}/lines`, (_body, query) =>
      ok(query.has('after') ? [line(101)] : Array.from({ length: 100 }, (_, n) => line(n + 1))),
    );
    api.install();
    await renderApp(`/inventory/opening/${id(71)}`);
    await screen.findByText('SKU-0100');
    fireEvent.click(screen.getByRole('button', { name: ar.common.next }));
    await screen.findByText('SKU-0101');
    const pages = api.calls.filter((c) => c.path === `/stock/opening/${id(71)}/lines`);
    expect(new URLSearchParams(pages.at(-1)?.query).get('after')).toBe('SKU-0100');
    fireEvent.click(screen.getByRole('button', { name: ar.common.previous }));
    await screen.findByText('SKU-0001');
  });

  it('is offered only to users who may see costs', async () => {
    new FakeApi()
      .on('GET /auth/me', ok(me(['stock.opening'])))
      .on('GET /locations', ok(LOCATIONS))
      .install();
    await renderApp('/inventory/opening');
    expect(await screen.findByText(ar.common.forbiddenHint)).toBeTruthy();
    expect(screen.queryByRole('link', { name: ar.nav.opening })).toBeNull();
  });
});

describe('counts (ADR 0025)', () => {
  const count: StockCount = {
    id: id(70),
    locationId: shop,
    scope: 'all',
    categoryId: null,
    status: 'open',
    note: null,
    createdAt: '2026-10-07T08:00:00.000Z',
    createdBy: id(1),
    closedAt: null,
    documentId: null,
    lines: 1,
    counted: 0,
  };
  const line: CountLine = {
    partId: id(1),
    sku: 'SKY-1',
    nameAr: 'فلتر',
    nameEn: null,
    counted: null,
    countedAt: null,
  };
  const show = async (permissions: Parameters<typeof me>[0], lines: CountLine[]) => {
    new FakeApi()
      .on('GET /auth/me', ok(me(permissions)))
      .on('GET /locations', ok(LOCATIONS))
      .on(`GET /stock/counts/${count.id}`, ok(count))
      .on(`GET /stock/counts/${count.id}/lines`, ok(lines))
      .install();
    await renderApp(`/inventory/counts/${count.id}`);
    await screen.findByText('SKY-1');
  };

  it('is blind for counters: no expected quantity, no difference', async () => {
    await show(['stock.count'], [line]);
    expect(screen.queryByRole('columnheader', { name: ar.count.expected })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: ar.count.variance })).toBeNull();
    expect(screen.queryByRole('button', { name: ar.count.approve })).toBeNull();
  });

  it('shows approvers what was expected and the difference', async () => {
    await show(
      ['stock.count', 'stock.approve_count'],
      [{ ...line, counted: 3, countedAt: '2026-10-07T09:00:00.000Z', expected: 5, variance: -2 }],
    );
    const row = screen.getByText('SKY-1').closest('tr');
    if (row === null) throw new Error('no row');
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    const n = (v: number) => new Intl.NumberFormat('ar').format(v);
    expect(cells.slice(-2)).toEqual([n(5), n(-2)]);
    expect(screen.getByRole('button', { name: ar.count.approve })).toBeTruthy();
  });
});

describe('locations (ADR 0018)', () => {
  it('shows a rename error in the rename dialog, and checks names in the app language', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['locations.manage'])))
      .on('GET /locations', ok(LOCATIONS))
      .on(`PATCH /locations/${shop}`, {
        status: 409,
        body: { error: { code: 'resource.conflict' } },
      });
    api.install();
    await renderApp('/locations');
    fireEvent.click(await screen.findByRole('button', { name: ar.locations.add }));
    expect(await screen.findByText(ar.validation.required)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ar.locations.rename }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(labelled(ar.locations.name)), {
      target: { value: 'المخزن' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    expect(await within(dialog).findByText(ar.errors.resource.conflict)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('review items (ADR 0020)', () => {
  const item = (n: number): ReviewItem => ({
    id: id(2000 + n),
    kind: 'negative_stock',
    partId: id(3000 + n),
    sku: `RV-${String(n).padStart(3, '0')}`,
    nameAr: null,
    nameEn: null,
    locationId: shop,
    moveId: id(4000 + n),
    documentId: id(5000 + n),
    quantity: 0,
    openedAt: '2026-10-07T10:00:00.000Z',
    resolvedAt: '2026-10-08T10:00:00.000Z',
    resolvedBy: id(1),
    resolutionNote: 'counted',
  });

  it('pages through resolved items', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['stock.review'])))
      .on('GET /locations', ok(LOCATIONS))
      .on('GET /stock/review-items', (_body, query) =>
        ok(
          query.get('status') === 'resolved' && query.get('offset') === '0'
            ? Array.from({ length: 100 }, (_, n) => item(n + 1))
            : query.get('status') === 'resolved'
              ? [item(101)]
              : [],
        ),
      );
    api.install();
    await renderApp('/inventory/review');
    fireEvent.click(await screen.findByText(ar.review.resolved));
    await screen.findByText('RV-100');
    fireEvent.click(screen.getByRole('button', { name: ar.common.next }));
    await screen.findByText('RV-101');
    const last = api.calls.filter((c) => c.path === '/stock/review-items').at(-1);
    expect(new URLSearchParams(last?.query).get('offset')).toBe('100');
  });
});
