import { IMPORT_MAX_FILE_BYTES } from '@autoparts/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import {
  ALL,
  CURRENCIES,
  FakeApi,
  SETTINGS,
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

const invalid = (issues: { path: string; message: string }[]) => ({
  status: 400,
  body: { error: { code: 'request.invalid', issues } },
});
const issueText = (field: string, message: string) =>
  ar.validation.withField.replace('{{field}}', field).replace('{{message}}', message);
const posted = (api: FakeApi, path: string) =>
  api.calls.filter((c) => c.method !== 'GET' && c.path === path);

/** The field's wrapper, where Mantine shows its error. */
const fieldOf = (label: string, scope: HTMLElement = document.body) =>
  within(scope)
    .getByLabelText(labelled(label), { selector: 'input' })
    .closest('.mantine-InputWrapper-root')!;

/** Lets any request a click started reach the fake API. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe('required fields are checked before anything is sent', () => {
  it('new part: a number without its kind is not dropped; the kind is asked for', async () => {
    const created = partDetail(part(1, 'SKY-1', null, 'فلتر'));
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/parts', ok([]))
      .on('POST /catalog/parts', ok(created));
    onPartPage(api, created).install();
    await renderApp('/catalog/parts');
    fireEvent.click(await screen.findByRole('button', { name: ar.catalog.newPart }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(labelled(ar.catalog.sku)), {
      target: { value: 'SKY-1' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.catalog.nameAr), {
      target: { value: 'فلتر' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.catalog.number), {
      target: { value: '04465-60320' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await settle();

    expect(fieldOf(ar.catalog.kind).textContent).toContain(ar.validation.required);
    expect(posted(api, '/catalog/parts')).toEqual([]);

    await pick(ar.catalog.kind, ar.catalog.numberKind.oem, dialog);
    expect(fieldOf(ar.catalog.kind).textContent).not.toContain(ar.validation.required);
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await waitFor(() => {
      expect(posted(api, '/catalog/parts')[0]?.body).toMatchObject({
        sku: 'SKY-1',
        numbers: [{ number: '04465-60320', kind: 'oem' }],
      });
    });
  });

  it('new part: asks for a name before sending', async () => {
    const api = new FakeApi().on('GET /auth/me', ok(me(ALL))).on('GET /catalog/parts', ok([]));
    api.install();
    await renderApp('/catalog/parts');
    fireEvent.click(await screen.findByRole('button', { name: ar.catalog.newPart }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(labelled(ar.catalog.sku)), {
      target: { value: 'SKY-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await settle();
    expect(fieldOf(ar.catalog.nameAr, dialog).textContent).toContain(ar.validation.name.required);
    expect(posted(api, '/catalog/parts')).toEqual([]);
  });

  it('part page: a price needs its list, a number needs its kind', async () => {
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'));
    const api = onPartPage(new FakeApi(), detail).on('GET /auth/me', ok(me(ALL)));
    api.install();
    await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByRole('heading', { name: 'SKY-1' });

    fireEvent.change(screen.getByLabelText(labelled(ar.catalog.price)), {
      target: { value: '10.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.setPrice }));
    expect(fieldOf(ar.catalog.priceList).textContent).toContain(ar.validation.required);

    fireEvent.change(screen.getByLabelText(labelled(ar.catalog.number)), {
      target: { value: '04465-60320' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.addNumber }));
    await settle();
    expect(fieldOf(ar.catalog.kind).textContent).toContain(ar.validation.required);
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('catalog setup: a brand needs a kind and a price list needs a currency', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/price-lists', ok([]))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /catalog/brands', ok([]))
      .on('GET /catalog/categories', ok([]));
    api.install();
    await renderApp('/catalog/setup');
    const lists = await screen.findByRole('tabpanel', { name: ar.setup.priceLists });
    fireEvent.change(within(lists).getByLabelText(labelled(ar.fields.name)), {
      target: { value: 'Retail' },
    });
    fireEvent.click(within(lists).getByRole('button', { name: ar.setup.add }));
    await settle();
    expect(fieldOf(ar.setup.currency, lists).textContent).toContain(ar.validation.required);

    fireEvent.click(screen.getByRole('tab', { name: ar.setup.brands }));
    const brands = await screen.findByRole('tabpanel', { name: ar.setup.brands });
    fireEvent.change(within(brands).getByLabelText(labelled(ar.fields.name)), {
      target: { value: 'Toyota' },
    });
    fireEvent.click(within(brands).getByRole('button', { name: ar.setup.add }));
    await settle();
    expect(fieldOf(ar.setup.kind, brands).textContent).toContain(ar.validation.required);

    fireEvent.click(screen.getByRole('tab', { name: ar.setup.categories }));
    const categories = await screen.findByRole('tabpanel', { name: ar.setup.categories });
    fireEvent.click(within(categories).getByRole('button', { name: ar.setup.add }));
    await settle();
    expect(fieldOf(ar.catalog.nameAr, categories).textContent).toContain(
      ar.validation.name.required,
    );
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('required text fields use the app language, not the browser', () => {
  it('sign-in: says in Arabic which fields are missing', async () => {
    const api = new FakeApi().on('GET /auth/me', {
      status: 401,
      body: { error: { code: 'auth.unauthenticated' } },
    });
    api.install();
    await renderApp('/');
    await screen.findByRole('heading', { name: ar.auth.title });
    fireEvent.change(screen.getByLabelText(labelled(ar.auth.shopCode)), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.submit }));
    await settle();
    for (const label of [ar.auth.shopCode, ar.auth.username, ar.auth.password]) {
      expect(fieldOf(label).textContent).toContain(ar.validation.required);
    }
    expect(posted(api, '/auth/login')).toEqual([]);
  });

  it('vehicle words: a word that means a vehicle needs the vehicle', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/vehicles', ok([]))
      .on('GET /catalog/vehicle-aliases', ok([]))
      .on('GET /catalog/categories', ok([]));
    api.install();
    await renderApp('/catalog/vehicles');
    fireEvent.change(await screen.findByLabelText(labelled(ar.vehicles.alias)), {
      target: { value: 'LC' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.vehicles.addAlias }));
    await settle();
    expect(fieldOf(ar.catalog.chooseVehicle).textContent).toContain(ar.validation.required);
    expect(posted(api, '/catalog/vehicle-aliases')).toEqual([]);
  });
});

describe('import file', () => {
  it('says the file is too large, with the limit, instead of "unreadable"', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/price-lists', ok([]))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /catalog/imports', ok([]));
    api.install();
    const { container } = await renderApp('/catalog/imports');
    await screen.findByRole('heading', { name: ar.import.title });
    const big = new File(['x'], 'stock.xlsx');
    Object.defineProperty(big, 'size', { value: IMPORT_MAX_FILE_BYTES + 1 });
    await act(async () => {
      fireEvent.change(container.querySelector('input[type=file]')!, {
        target: { files: [big] },
      });
      await Promise.resolve();
    });
    const limit = new Intl.NumberFormat('ar', {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    }).format(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    const field = screen
      .getByLabelText(labelled(ar.import.file))
      .closest('.mantine-InputWrapper-root')!;
    expect(field.textContent).toContain(ar.import.fileTooLarge.replace('{{max}}', limit));
    expect(field.textContent).not.toContain(ar.errors.import.unreadable_file);
    expect(screen.getByRole('button', { name: ar.import.read })).toHaveProperty('disabled', true);
  });
});

describe('import mapping is checked before staging', () => {
  async function columnsStep() {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/price-lists', ok([]))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /catalog/imports', ok([]))
      .on(
        'POST /catalog/imports/inspect',
        ok({
          sheets: [
            {
              name: 'LAND',
              rowCount: 2,
              columnCount: 3,
              rows: [
                ['Part', 'Name', 'Price'],
                ['A-1', 'Filter', '10'],
              ],
            },
          ],
        }),
      );
    api.install();
    const { container } = await renderApp('/catalog/imports');
    await screen.findByRole('heading', { name: ar.import.title });
    const input = container.querySelector('input[type=file]')!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['xlsx'], 'stock.xlsx')] } });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: ar.import.read }));
    fireEvent.click(await screen.findByRole('button', { name: ar.import.next }));
    return api;
  }

  it('asks for the price list and the SKU prefix', async () => {
    const api = await columnsStep();
    await pick(ar.import.field.partNumber, 'A — Part');
    await pick(ar.import.field.sellPrice, 'C — Price');
    await pick(ar.import.numberKind, ar.catalog.numberKind.oem);
    fireEvent.click(screen.getByRole('button', { name: ar.import.stage }));
    await settle();
    expect(fieldOf(ar.import.priceList).textContent).toContain(ar.validation.required);
    expect(
      screen.getByLabelText(labelled(ar.import.skuPrefix)).closest('.mantine-InputWrapper-root')!
        .textContent,
    ).toContain(ar.validation.required);
    expect(posted(api, '/catalog/imports')).toEqual([]);
  });

  it('explains a mapping without a part number or name, in Arabic', async () => {
    const api = await columnsStep();
    await pick(ar.import.field.sku, 'A — Part');
    await pick(ar.import.numberKind, ar.catalog.numberKind.oem);
    fireEvent.click(screen.getByRole('button', { name: ar.import.stage }));
    await settle();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ar.validation.import.mapping_needs_identity);
    expect(alert.textContent).not.toMatch(/mapping|columns/);
    expect(posted(api, '/catalog/imports')).toEqual([]);
  });
});

describe('validation errors from the API', () => {
  it('names the field and the problem in Arabic, never the raw field path', async () => {
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'));
    onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `PATCH /catalog/parts/${detail.id}`,
        invalid([
          { path: 'sku', message: 'sku.invalid' },
          { path: 'nameAr', message: 'name.required' },
          { path: 'mapping.priceListId', message: 'import.mapping_needs_price_list' },
          { path: 'settings.session.idleMinutes', message: 'Too big: expected <=1440' },
          { path: 'numbers.0.number', message: 'Too small' },
          { path: 'somethingNew', message: 'Unknown' },
        ]),
      )
      .install();
    await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByRole('heading', { name: 'SKY-1' });
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    const alert = await screen.findByRole('alert');
    const lines = [...alert.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines).toEqual([
      issueText(ar.fields.sku, ar.validation.sku.invalid),
      issueText(ar.fields.nameAr, ar.validation.name.required),
      issueText(ar.fields.priceListId, ar.validation.import.mapping_needs_price_list),
      issueText(ar.fields.idleMinutes, ar.validation.invalid),
      issueText(ar.fields.number, ar.validation.invalid),
      ar.validation.invalid,
    ]);
    expect(alert.textContent).not.toMatch(/[a-zA-Z]/);
  });

  it('settings: shows the field label for nested settings paths', async () => {
    new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /settings', ok(SETTINGS))
      .on('GET /currencies', ok(CURRENCIES))
      .on(
        'PUT /settings',
        invalid([{ path: 'settings.money.roundingMode', message: 'Invalid option' }]),
      )
      .install();
    await renderApp('/settings');
    await screen.findByLabelText(ar.settings.shopName, { exact: false });
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      issueText(ar.fields.roundingMode, ar.validation.invalid),
    );
  });
});
