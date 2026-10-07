import type {
  CountLine,
  CurrentFxRates,
  OpeningDraft,
  PartStock,
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
