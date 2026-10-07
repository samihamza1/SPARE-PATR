import { withTenant } from '@autoparts/db';
import type { DB } from '@autoparts/db';
import { QUALITY_GRADES, newId } from '@autoparts/shared';
import type { Kysely } from 'kysely';

/**
 * Synthetic catalog for performance tests and demos (never customer data). Everything,
 * including the vehicle tree, is created as rows of the given tenant, so the shared
 * vehicle tree is never touched. Deterministic for a given seed.
 */

const PARTS_EN = [
  'Brake pad set',
  'Oil filter',
  'Air filter',
  'Fuel filter',
  'Spark plug',
  'Shock absorber',
  'Wheel bearing',
  'Water pump',
  'Timing belt',
  'Clutch disc',
  'Radiator hose',
  'Alternator',
  'Starter motor',
  'Head lamp',
  'Fan belt',
  'Tie rod end',
  'Ball joint',
  'CV joint',
  'Brake disc',
  'Wiper blade',
];
const PARTS_AR = [
  'فحمات فرامل',
  'مصفي زيت',
  'فلتر هواء',
  'فلتر ديزل',
  'بوجي',
  'مساعد',
  'رولمان عجل',
  'طرمبة ماء',
  'سير تايمن',
  'ديسك كلتش',
  'خرطوم رديتر',
  'دينمو',
  'سلف',
  'فانوس',
  'سير مروحة',
  'راس دركسون',
  'كرة مقص',
  'عكس',
  'هوب فرامل',
  'مساحات',
];
const SIDES_EN = ['front', 'rear', 'left', 'right', 'upper', 'lower'];
const SIDES_AR = ['امامي', 'خلفي', 'يسار', 'يمين', 'علوي', 'سفلي'];

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

async function insertChunks<T>(items: readonly T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += 1000) await insert(items.slice(i, i + 1000));
}

export interface SyntheticOptions {
  parts: number;
  seed?: number;
  /** Price list currency (a tenant currency); prices get two decimals or fewer. */
  currency: string;
  minorUnits: number;
  /** When the prices take effect (default: now). Tests with a fixed clock pass theirs. */
  effectiveAt?: Date;
}

export interface SyntheticVehicle {
  modelName: string;
  generationId: string;
  yearFrom: number;
  yearTo: number;
}

export interface SyntheticPart {
  id: string;
  nameEn: string;
  number: string;
  vehicle: SyntheticVehicle;
}

export async function seedSyntheticCatalog(
  db: Kysely<DB>,
  tenantId: string,
  options: SyntheticOptions,
): Promise<{ parts: SyntheticPart[]; priceListId: string }> {
  const rnd = prng(options.seed ?? 1);
  const vehicles: {
    id: string;
    parent_id: string | null;
    level: string;
    name: string;
    year_from?: number;
    year_to?: number;
  }[] = [];
  const generations: SyntheticVehicle[] = [];
  const typeId = newId();
  vehicles.push({ id: typeId, parent_id: null, level: 'type', name: 'Synthetic' });
  for (let m = 1; m <= 20; m++) {
    const makeId = newId();
    vehicles.push({ id: makeId, parent_id: typeId, level: 'make', name: `Make ${pad(m, 2)}` });
    for (let d = 1; d <= 10; d++) {
      const modelId = newId();
      const modelName = `Model ${pad(m, 2)}-${pad(d, 2)}`;
      vehicles.push({ id: modelId, parent_id: makeId, level: 'model', name: modelName });
      for (let g = 0; g < 3; g++) {
        const id = newId();
        const yearFrom = 1995 + g * 10;
        const yearTo = yearFrom + 9;
        vehicles.push({
          id,
          parent_id: modelId,
          level: 'generation',
          name: `G${String(g + 1)}`,
          year_from: yearFrom,
          year_to: yearTo,
        });
        generations.push({ modelName, generationId: id, yearFrom, yearTo });
      }
    }
  }

  const parts: SyntheticPart[] = [];
  const partRows: {
    id: string;
    tenant_id: string;
    sku: string;
    name_ar: string;
    name_en: string;
    quality_grade: string | null;
  }[] = [];
  const numbers: {
    id: string;
    tenant_id: string;
    part_id: string;
    number: string;
    kind: string;
  }[] = [];
  const fitments: { id: string; tenant_id: string; part_id: string; vehicle_id: string }[] = [];
  const prices: {
    id: string;
    tenant_id: string;
    price_list_id: string;
    part_id: string;
    price: string;
    effective_at: Date;
    source: string;
  }[] = [];
  const members: { id: string; tenant_id: string; group_id: string; part_id: string }[] = [];
  const groups: { id: string; tenant_id: string }[] = [];
  const priceListId = newId();
  const now = options.effectiveAt ?? new Date();

  for (let i = 1; i <= options.parts; i++) {
    const id = newId();
    const kindIndex = rnd.int(PARTS_EN.length);
    const side = rnd.int(SIDES_EN.length);
    const vehicle = rnd.pick(generations);
    // One in five parts shares an OEM number with an earlier part: they become alternatives.
    const shared = i > 1 && rnd.next() < 0.2 ? rnd.pick(parts) : undefined;
    const number = shared?.number ?? `${pad(10000 + rnd.int(89999), 5)}-${pad(rnd.int(99999), 5)}`;
    const nameEn = `${PARTS_EN[kindIndex] ?? ''} ${SIDES_EN[side] ?? ''}`;
    partRows.push({
      id,
      tenant_id: tenantId,
      sku: `SYN-${pad(i, 6)}`,
      name_ar: `${PARTS_AR[kindIndex] ?? ''} ${SIDES_AR[side] ?? ''}`,
      name_en: nameEn,
      quality_grade: rnd.next() < 0.3 ? null : rnd.pick(QUALITY_GRADES),
    });
    numbers.push({ id: newId(), tenant_id: tenantId, part_id: id, number, kind: 'oem' });
    fitments.push({
      id: newId(),
      tenant_id: tenantId,
      part_id: id,
      vehicle_id: vehicle.generationId,
    });
    const cents = 100 + rnd.int(50_000);
    const price =
      options.minorUnits >= 2
        ? `${String(Math.floor(cents / 100))}.${pad(cents % 100, 2)}`
        : String(Math.floor(cents / 100));
    prices.push({
      id: newId(),
      tenant_id: tenantId,
      price_list_id: priceListId,
      part_id: id,
      price,
      effective_at: now,
      source: 'manual',
    });
    parts.push({ id, nameEn, number, vehicle });
  }
  // One in ten parts sits in an interchange group of three.
  for (let i = 0; i + 2 < parts.length; i += 30) {
    const group = newId();
    groups.push({ id: group, tenant_id: tenantId });
    for (const p of parts.slice(i, i + 3)) {
      members.push({ id: newId(), tenant_id: tenantId, group_id: group, part_id: p.id });
    }
  }

  await withTenant(db, tenantId, async (trx) => {
    await insertChunks(vehicles, (chunk) =>
      trx
        .insertInto('vehicles')
        .values(chunk.map((v) => ({ ...v, tenant_id: tenantId })))
        .execute(),
    );
    await trx
      .insertInto('price_lists')
      .values({
        id: priceListId,
        tenant_id: tenantId,
        name: 'Synthetic',
        currency: options.currency,
        is_default: true,
      })
      .execute();
    await insertChunks(partRows, (chunk) => trx.insertInto('parts').values(chunk).execute());
    await insertChunks(numbers, (chunk) => trx.insertInto('part_numbers').values(chunk).execute());
    await insertChunks(fitments, (chunk) => trx.insertInto('fitments').values(chunk).execute());
    await insertChunks(prices, (chunk) => trx.insertInto('part_prices').values(chunk).execute());
    await insertChunks(groups, (chunk) =>
      trx.insertInto('interchange_groups').values(chunk).execute(),
    );
    await insertChunks(members, (chunk) =>
      trx.insertInto('interchange_members').values(chunk).execute(),
    );
  });
  return { parts, priceListId };
}
