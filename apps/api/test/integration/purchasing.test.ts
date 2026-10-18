import { newId } from '@autoparts/shared';
import type {
  AuditEntry,
  Currency,
  PartDetail,
  ResolveSupplierNumbersResponse,
  Role,
  Supplier,
  SupplierPart,
  SupplierPartPage,
} from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client, Shop } from './harness';
import { errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let cashier: Client;
let accountant: Client;
let supervisor: Client;

async function createUser(username: string, roleCode: string): Promise<Client> {
  const roles = (await owner.get('/roles')).json<Role[]>();
  const role = roles.find((r) => r.code === roleCode);
  const password = `${username} passphrase 1`;
  const id = newId();
  const res = await owner.post('/users', { id, username, displayName: username, password });
  expect(res.statusCode, res.body).toBe(201);
  const granted = await owner.post(`/users/${id}/roles`, { roleId: role?.id });
  expect(granted.statusCode, granted.body).toBeLessThan(300);
  return loggedIn(env, shop, username, password);
}

async function createPart(sku: string, numbers: string[] = []): Promise<PartDetail> {
  const res = await owner.post('/catalog/parts', { id: newId(), sku, nameEn: sku });
  expect(res.statusCode, res.body).toBe(201);
  const part = res.json<PartDetail>();
  for (const number of numbers) {
    const added = await owner.post(`/catalog/parts/${part.id}/numbers`, {
      id: newId(),
      number,
      kind: 'oem',
    });
    expect(added.statusCode, added.body).toBe(200);
  }
  return part;
}

async function createSupplier(name: string, extra: Record<string, unknown> = {}) {
  const res = await owner.post('/suppliers', { id: newId(), name, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Supplier>();
}

async function auditOf(entityId: string): Promise<AuditEntry[]> {
  const res = await owner.get(`/audit-log?entityType=supplier&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AuditEntry[]>();
}

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  cashier = await createUser('cash', 'cashier');
  accountant = await createUser('books', 'accountant');
  supervisor = await createUser('super', 'supervisor');
  const bbb = await owner.post('/currencies', { id: newId(), code: 'BBB', minorUnits: 2 });
  expect(bbb.statusCode, bbb.body).toBe(201);
});

describe('suppliers', () => {
  it('are created once per id; a retry returns the supplier, another body conflicts', async () => {
    const body = { id: newId(), name: 'Gulf Parts', defaultCurrency: 'BBB', phone: '+971 4 000' };
    const res = await supervisor.post('/suppliers', body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<Supplier>()).toMatchObject({
      name: 'Gulf Parts',
      defaultCurrency: 'BBB',
      phone: '+971 4 000',
      note: null,
      archivedAt: null,
    });
    const again = await supervisor.post('/suppliers', body);
    expect(again.statusCode).toBe(200);
    expect(again.json<Supplier>().id).toBe(body.id);
    const changed = await supervisor.post('/suppliers', { ...body, name: 'Other' });
    expect(errorCode(changed)).toBe('idempotency.conflict');
    // A late retry after an edit still answers 200, with the supplier as it is now.
    await owner.patch(`/suppliers/${body.id}`, { phone: '+971 4 111' });
    const late = await supervisor.post('/suppliers', body);
    expect(late.statusCode).toBe(200);
    expect(late.json<Supplier>().phone).toBe('+971 4 111');
    // Active suppliers have distinct names (after normalisation).
    const twin = await owner.post('/suppliers', { id: newId(), name: '  gulf   PARTS ' });
    expect(errorCode(twin)).toBe('resource.conflict');
  });

  it('settle concurrent identical creates on one row', async () => {
    const body = { id: newId(), name: 'Race Motors' };
    const [a, b] = await Promise.all([
      owner.post('/suppliers', body),
      owner.post('/suppliers', body),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const list = (await owner.get('/suppliers?q=race')).json<Supplier[]>();
    expect(list.map((s) => s.id)).toEqual([body.id]);
  });

  it('take a default currency only among active tenant currencies', async () => {
    const unknown = await owner.post('/suppliers', {
      id: newId(),
      name: 'No such money',
      defaultCurrency: 'ZZZ',
    });
    expect(unknown.statusCode).toBe(400);
    const ccc = await owner.post('/currencies', { id: newId(), code: 'CCC', minorUnits: 0 });
    expect(ccc.statusCode, ccc.body).toBe(201);
    const off = await owner.patch(`/currencies/${ccc.json<Currency>().id}`, { isActive: false });
    expect(off.statusCode, off.body).toBe(200);
    const inactive = await owner.post('/suppliers', {
      id: newId(),
      name: 'Old money',
      defaultCurrency: 'CCC',
    });
    expect(errorCode(inactive)).toBe('currency.inactive');
  });

  it('are listed, searched, renamed, archived and restored, with an audit trail', async () => {
    const s = await createSupplier('Juba Spares', { note: 'Pays cash' });
    let list = (await owner.get('/suppliers?q=juba')).json<Supplier[]>();
    expect(list.map((x) => x.id)).toEqual([s.id]);

    const renamed = await owner.patch(`/suppliers/${s.id}`, {
      name: 'Juba Spares Ltd',
      phone: '123',
    });
    expect(renamed.json<Supplier>()).toMatchObject({ name: 'Juba Spares Ltd', phone: '123' });
    const archived = await owner.patch(`/suppliers/${s.id}`, { archived: true });
    expect(archived.json<Supplier>().archivedAt).not.toBeNull();
    list = (await owner.get('/suppliers?q=juba')).json<Supplier[]>();
    expect(list).toEqual([]);
    list = (await owner.get('/suppliers?q=juba&includeArchived=true')).json<Supplier[]>();
    expect(list.map((x) => x.id)).toEqual([s.id]);
    const restored = await owner.patch(`/suppliers/${s.id}`, { archived: false });
    expect(restored.json<Supplier>().archivedAt).toBeNull();

    const actions = (await auditOf(s.id)).map((e) => e.action).sort();
    expect(actions).toEqual([
      'supplier.create',
      'supplier.update',
      'supplier.update',
      'supplier.update',
    ]);
  });

  it('are read with purchases.view and changed with purchases.manage only', async () => {
    expect((await accountant.get('/suppliers')).statusCode).toBe(200);
    const denied = await accountant.post('/suppliers', { id: newId(), name: 'Nope' });
    expect(denied.statusCode).toBe(403);
    expect((await cashier.get('/suppliers')).statusCode).toBe(403);
    expect((await cashier.post('/suppliers', { id: newId(), name: 'Nope' })).statusCode).toBe(403);
  });
});

describe('supplier part numbers', () => {
  let supplier: Supplier;
  let filter: PartDetail;
  let pads: PartDetail;

  beforeAll(async () => {
    supplier = await createSupplier('Number House');
    filter = await createPart('FLT-100', ['90915-YZZE1']);
    pads = await createPart('PAD-200');
  });

  it('map a printed number once; the same mapping again changes nothing', async () => {
    const body = { id: newId(), partId: filter.id, number: 'GP-0042' };
    const res = await owner.post(`/suppliers/${supplier.id}/parts`, body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<SupplierPart>()).toMatchObject({
      id: body.id,
      supplierId: supplier.id,
      number: 'GP-0042',
      part: { id: filter.id, sku: 'FLT-100' },
    });
    // Retrying the request, or mapping the same number (any spelling) to the same part.
    expect((await owner.post(`/suppliers/${supplier.id}/parts`, body)).statusCode).toBe(200);
    const spelled = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: filter.id,
      number: 'gp 0042',
    });
    expect(spelled.statusCode).toBe(200);
    expect(spelled.json<SupplierPart>().id).toBe(body.id);
    const page = (await owner.get(`/suppliers/${supplier.id}/parts`)).json<SupplierPartPage>();
    expect(page.total).toBe(1);
  });

  it('refuse a number already mapped to another part, and a changed retry', async () => {
    const taken = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: pads.id,
      number: 'GP.0042',
    });
    expect(errorCode(taken)).toBe('supplier_part.taken');
    const page = (
      await owner.get(`/suppliers/${supplier.id}/parts?q=gp0042`)
    ).json<SupplierPartPage>();
    const [mapping] = page.items;
    const changed = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: mapping?.id,
      partId: pads.id,
      number: 'GP-0042',
    });
    expect(errorCode(changed)).toBe('idempotency.conflict');
  });

  it('refuse numbers with nothing but separators', async () => {
    const res = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: pads.id,
      number: ' - / ',
    });
    expect(res.statusCode).toBe(400);
  });

  it('are removed for good; the number can then point elsewhere', async () => {
    const page = (await owner.get(`/suppliers/${supplier.id}/parts`)).json<SupplierPartPage>();
    const [mapping] = page.items;
    if (mapping === undefined) throw new Error('expected a mapping');
    const removed = await owner.post(`/suppliers/${supplier.id}/parts/${mapping.id}/remove`, {});
    expect(removed.statusCode, removed.body).toBe(200);
    const twice = await owner.post(`/suppliers/${supplier.id}/parts/${mapping.id}/remove`, {});
    expect(twice.statusCode).toBe(404);
    // A late retry of the original create returns the mapping, marked removed.
    const replay = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: mapping.id,
      partId: mapping.part.id,
      number: mapping.number,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<SupplierPart>().removedAt).not.toBeNull();
    const remapped = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: pads.id,
      number: 'GP-0042',
    });
    expect(remapped.statusCode, remapped.body).toBe(201);
    const actions = (await auditOf(supplier.id)).map((e) => e.action).sort();
    expect(actions).toEqual([
      'supplier.create',
      'supplier_part.add',
      'supplier_part.add',
      'supplier_part.remove',
    ]);
  });

  it('are not added for archived parts or archived suppliers', async () => {
    const old = await createPart('OLD-300');
    expect((await owner.patch(`/catalog/parts/${old.id}`, { archived: true })).statusCode).toBe(
      200,
    );
    const archivedPart = await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: old.id,
      number: 'GP-0300',
    });
    expect(errorCode(archivedPart)).toBe('catalog.archived');

    const gone = await createSupplier('Gone Trading');
    await owner.patch(`/suppliers/${gone.id}`, { archived: true });
    const archivedSupplier = await owner.post(`/suppliers/${gone.id}/parts`, {
      id: newId(),
      partId: pads.id,
      number: 'GT-1',
    });
    expect(errorCode(archivedSupplier)).toBe('supplier.archived');
  });

  it('are listed with search and paging, for purchases.view only', async () => {
    for (const n of ['GP-A1', 'GP-A2', 'GP-A3']) {
      const res = await owner.post(`/suppliers/${supplier.id}/parts`, {
        id: newId(),
        partId: filter.id,
        number: n,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const first = (
      await accountant.get(`/suppliers/${supplier.id}/parts?q=gpa&limit=2`)
    ).json<SupplierPartPage>();
    expect(first.total).toBe(3);
    expect(first.items.map((m) => m.number)).toEqual(['GP-A1', 'GP-A2']);
    const next = (
      await accountant.get(`/suppliers/${supplier.id}/parts?q=gpa&limit=2&offset=2`)
    ).json<SupplierPartPage>();
    expect(next.items.map((m) => m.number)).toEqual(['GP-A3']);
    const bySku = (
      await accountant.get(`/suppliers/${supplier.id}/parts?q=flt-100`)
    ).json<SupplierPartPage>();
    expect(bySku.total).toBe(3);
    expect((await cashier.get(`/suppliers/${supplier.id}/parts`)).statusCode).toBe(403);
  });
});

describe('resolving supplier numbers', () => {
  let supplier: Supplier;

  beforeAll(async () => {
    supplier = await createSupplier('Resolver Co');
  });

  it('answers remembered, candidates or none, exactly and in the order asked', async () => {
    const mapped = await createPart('BAT-500');
    const shared1 = await createPart('BRK-600', ['04465-33450']);
    const shared2 = await createPart('BRK-601', ['0446533450']);
    const bySku = await createPart('OIL-700');
    await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: mapped.id,
      number: 'RC-BAT',
    });

    const res = await accountant.post(`/suppliers/${supplier.id}/resolve`, {
      numbers: ['rc bat', '04465 33450', 'oil700', '04465', 'RC-BAT'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const results = res.json<ResolveSupplierNumbersResponse>().results;
    expect(results.map((r) => [r.number, r.status])).toEqual([
      ['rc bat', 'remembered'],
      ['04465 33450', 'candidates'],
      ['oil700', 'candidates'],
      // A prefix is not a match: the system never guesses.
      ['04465', 'none'],
      ['RC-BAT', 'remembered'],
    ]);
    expect(results[0]?.mapping).toMatchObject({ part: { id: mapped.id }, replacement: null });
    // Several parts share the number: all are offered, none is picked.
    expect(results[1]?.candidates.map((p) => p.id).sort()).toEqual([shared1.id, shared2.id].sort());
    expect(results[2]?.candidates.map((p) => p.id)).toEqual([bySku.id]);
  });

  it('offers the part that replaces an archived one', async () => {
    const old = await createPart('ALT-800', ['27060-0V010']);
    const current = await createPart('ALT-801');
    await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: old.id,
      number: 'RC-ALT',
    });
    const superseded = await owner.post(`/catalog/parts/${old.id}/supersede`, {
      id: newId(),
      newPartId: current.id,
    });
    expect(superseded.statusCode, superseded.body).toBe(200);
    expect((await owner.patch(`/catalog/parts/${old.id}`, { archived: true })).statusCode).toBe(
      200,
    );

    const results = (
      await owner.post(`/suppliers/${supplier.id}/resolve`, { numbers: ['RC-ALT', '270600V010'] })
    ).json<ResolveSupplierNumbersResponse>().results;
    expect(results[0]).toMatchObject({
      status: 'remembered',
      mapping: { part: { id: old.id }, replacement: { id: current.id } },
    });
    expect(results[1]).toMatchObject({ status: 'candidates' });
    expect(results[1]?.candidates.map((p) => p.id)).toEqual([current.id]);
  });

  it('offers the replacement of a remembered part that is superseded but still active', async () => {
    const old = await createPart('STR-900');
    const current = await createPart('STR-901');
    await owner.post(`/suppliers/${supplier.id}/parts`, {
      id: newId(),
      partId: old.id,
      number: 'RC-STR',
    });
    await owner.post(`/catalog/parts/${old.id}/supersede`, { id: newId(), newPartId: current.id });
    const [result] = (
      await owner.post(`/suppliers/${supplier.id}/resolve`, { numbers: ['RC-STR'] })
    ).json<ResolveSupplierNumbersResponse>().results;
    expect(result).toMatchObject({
      status: 'remembered',
      mapping: { part: { id: old.id, archivedAt: null }, replacement: { id: current.id } },
    });
  });

  it('is refused to cashiers and for unknown suppliers', async () => {
    const body = { numbers: ['X1'] };
    expect((await cashier.post(`/suppliers/${supplier.id}/resolve`, body)).statusCode).toBe(403);
    expect((await owner.post(`/suppliers/${newId()}/resolve`, body)).statusCode).toBe(404);
  });
});
