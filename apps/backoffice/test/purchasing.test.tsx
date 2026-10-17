import type { Supplier, SupplierPartPage } from '@autoparts/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import { CURRENCIES, FakeApi, id, labelled, me, ok, part, pick, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BBB = { ...CURRENCIES[0]!, id: id(401), code: 'BBB', isFunctional: false };
const OFF = { ...CURRENCIES[0]!, id: id(402), code: 'CCC', isFunctional: false, isActive: false };

const gulf: Supplier = {
  id: id(501),
  name: 'Gulf Parts',
  defaultCurrency: 'BBB',
  phone: null,
  note: null,
  archivedAt: null,
};

const textbox = (name: string) => screen.getByRole('textbox', { name: new RegExp(name) });

describe('suppliers (ADR 0026)', () => {
  it('adds a supplier with an active default currency; blank fields go as null', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['purchases.view', 'purchases.manage'])))
      .on('GET /currencies', ok([...CURRENCIES, BBB, OFF]))
      .on('GET /suppliers', ok([]))
      .on('POST /suppliers', { status: 201, body: gulf });
    api.install();
    await renderApp('/purchasing/suppliers');
    expect(await screen.findByText(ar.suppliers.none)).toBeTruthy();

    // The name is required before anything is sent.
    fireEvent.click(screen.getByRole('button', { name: ar.suppliers.add }));
    expect(await screen.findByText(ar.validation.required)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);

    fireEvent.change(textbox(ar.suppliers.name), { target: { value: ' Gulf Parts ' } });
    // Switched-off currencies are not offered.
    await pick(ar.suppliers.defaultCurrency, 'BBB');
    expect(screen.queryByRole('option', { name: 'CCC' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ar.suppliers.add }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        id: expect.any(String) as string,
        name: 'Gulf Parts',
        defaultCurrency: 'BBB',
        phone: null,
        note: null,
      });
    });
  });

  it('shows the list read-only to purchases.view, with the part numbers drawer', async () => {
    const page: SupplierPartPage = {
      total: 1,
      items: [
        {
          id: id(601),
          supplierId: gulf.id,
          number: 'GP-0042',
          part: part(1, 'FLT-100', 'oem', 'فلتر'),
          createdAt: '2026-10-16T08:00:00.000Z',
        },
      ],
    };
    new FakeApi()
      .on('GET /auth/me', ok(me(['purchases.view'])))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /suppliers', ok([gulf]))
      .on(`GET /suppliers/${gulf.id}/parts`, ok(page))
      .install();
    await renderApp('/purchasing/suppliers');
    const row = (await screen.findByText('Gulf Parts')).closest('tr');
    expect(row).not.toBeNull();
    expect(screen.queryByRole('button', { name: ar.suppliers.add })).toBeNull();
    expect(within(row!).queryByRole('button', { name: ar.suppliers.edit })).toBeNull();
    fireEvent.click(within(row!).getByRole('button', { name: ar.suppliers.numbers }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('GP-0042')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: ar.suppliers.addNumber })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: ar.suppliers.removeNumber })).toBeNull();
  });

  it('asks before archiving, and maps a number to a chosen part', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const filter = part(1, 'FLT-100', 'oem', 'فلتر');
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(['purchases.view', 'purchases.manage'])))
      .on('GET /currencies', ok(CURRENCIES))
      .on('GET /suppliers', ok([gulf]))
      .on(`PATCH /suppliers/${gulf.id}`, ok({ ...gulf, archivedAt: '2026-10-16T08:00:00.000Z' }))
      .on(`GET /suppliers/${gulf.id}/parts`, ok({ total: 0, items: [] }))
      .on('GET /catalog/parts', ok([filter]))
      .on(`POST /suppliers/${gulf.id}/parts`, { status: 201, body: {} });
    api.install();
    await renderApp('/purchasing/suppliers');
    const row = (await screen.findByText('Gulf Parts')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: ar.suppliers.archive }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ archived: true });
    });
    expect(confirm).toHaveBeenCalledOnce();

    fireEvent.click(within(row).getByRole('button', { name: ar.suppliers.numbers }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(
      within(drawer).getByRole('textbox', { name: new RegExp(ar.suppliers.number) }),
      {
        target: { value: ' GP-0042 ' },
      },
    );
    // Without a part the mapping is not sent.
    fireEvent.click(within(drawer).getByRole('button', { name: ar.suppliers.addNumber }));
    expect(await within(drawer).findByText(ar.suppliers.choosePart)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);

    const user = userEvent.setup();
    await user.type(
      within(drawer).getByLabelText(labelled(ar.suppliers.part), { selector: 'input' }),
      'FLT',
    );
    await user.click(await screen.findByRole('option', { name: /FLT-100/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: ar.suppliers.addNumber }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        id: expect.any(String) as string,
        partId: filter.id,
        number: 'GP-0042',
      });
    });
  });
});
