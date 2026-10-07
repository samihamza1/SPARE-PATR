import type { AuditEntry } from '@autoparts/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import {
  ALL,
  FakeApi,
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

describe('archived parts', () => {
  it('can be listed again, so they can be restored', async () => {
    const archived = part(2, 'SKY-00002', null, 'فحمات', {
      archivedAt: '2026-10-01T08:00:00.000Z',
    });
    const api = new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /catalog/parts', (_b, q) =>
        ok(
          q.get('includeArchived') === 'true'
            ? [part(1, 'SKY-00001', null, 'مصفي'), archived]
            : [part(1, 'SKY-00001', null, 'مصفي')],
        ),
      );
    api.install();
    await renderApp('/catalog/parts');
    await screen.findByText('SKY-00001');
    expect(screen.queryByText('SKY-00002')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: ar.catalog.showArchived }));
    const row = (await screen.findByText('SKY-00002')).closest('tr');
    expect(row === null ? '' : within(row).getByText(ar.catalog.archived).textContent).toBe(
      ar.catalog.archived,
    );
  });

  it('asks before archiving a part', async () => {
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'));
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `PATCH /catalog/parts/${detail.id}`,
        ok({ ...detail, archivedAt: '2026-10-07T08:00:00Z' }),
      );
    api.install();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderApp(`/catalog/parts/${detail.id}`);
    fireEvent.click(await screen.findByRole('button', { name: ar.catalog.archive }));
    expect(confirm).toHaveBeenCalledWith(ar.catalog.archiveConfirm);
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.archive }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ archived: true });
    });
  });
});

describe('part page', () => {
  it('keeps unsaved details while a number is added', async () => {
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'));
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `POST /catalog/parts/${detail.id}/numbers`,
        ok({
          ...detail,
          numbers: [
            {
              id: id(70),
              number: '04465-60320',
              numberNorm: '0446560320',
              kind: 'oem',
              brandId: null,
            },
          ],
        }),
      );
    api.install();
    await renderApp(`/catalog/parts/${detail.id}`);
    const notes = await screen.findByLabelText(labelled(ar.catalog.notes));
    fireEvent.change(notes, { target: { value: 'typed, not saved yet' } });

    fireEvent.change(screen.getByLabelText(labelled(ar.catalog.number)), {
      target: { value: '04465-60320' },
    });
    await pick(ar.catalog.kind, ar.catalog.numberKind.oem);
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.addNumber }));
    await screen.findByText('04465-60320');
    expect(screen.getByLabelText<HTMLTextAreaElement>(labelled(ar.catalog.notes)).value).toBe(
      'typed, not saved yet',
    );
  });

  it('shows where a vehicle sits in the tree, root first, with the translated separator', async () => {
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'), {
      fitments: [
        { id: id(80), vehicleId: id(90), path: ['Car', 'Toyota', 'Land Cruiser'], note: null },
      ],
    });
    onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .install();
    await renderApp(`/catalog/parts/${detail.id}`);
    const path = await screen.findByLabelText(ar.catalog.vehiclePath);
    expect(path.textContent).toBe(['Car', 'Toyota', 'Land Cruiser'].join(ar.catalog.pathSeparator));
  });
});

describe('audit log', () => {
  it('shows what a change replaced, and why', async () => {
    const entry: AuditEntry = {
      id: id(100),
      occurredAt: '2026-10-07T08:00:00.000Z',
      actorUserId: null,
      action: 'price.set',
      entityType: 'part',
      entityId: id(1),
      before: { priceListId: id(50), price: '17.86' },
      after: { priceListId: id(50), price: '19.00' },
      reason: 'Supplier list 2026',
    };
    new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('GET /users', ok([]))
      .on('GET /audit-log', ok([entry]))
      .install();
    await renderApp('/audit');
    await screen.findByText(ar.audit.reasonText.replace('{{reason}}', 'Supplier list 2026'));
    const price = screen.getByText('price').closest('tr');
    if (price === null) throw new Error('no price row');
    expect([...price.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'price',
      '17.86',
      '19.00',
    ]);
    // The changed field comes first.
    const rows = screen.getAllByRole('row').map((r) => r.querySelector('td')?.textContent);
    expect(rows.indexOf('price')).toBeLessThan(rows.indexOf('priceListId'));
  });
});

describe('replacement', () => {
  it('removes a wrong replacement, with the vehicles it copied, after asking', async () => {
    const replacement = part(2, 'SKY-2', null, 'فلتر جديد');
    const detail = partDetail(part(1, 'SKY-1', null, 'فلتر'), { supersededBy: replacement });
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .on(
        `POST /catalog/parts/${detail.id}/supersede/remove`,
        ok({ ...detail, supersededBy: null }),
      );
    api.install();
    vi.stubGlobal('confirm', () => true);
    await renderApp(`/catalog/parts/${detail.id}`);
    fireEvent.change(await screen.findByLabelText(labelled(ar.catalog.reason)), {
      target: { value: 'wrong part' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.removeSupersession }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.path.endsWith('/supersede/remove'))?.body).toEqual({
        removeCopiedFitments: true,
        reason: 'wrong part',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: ar.catalog.removeSupersession })).toBeNull();
    });
  });
});
