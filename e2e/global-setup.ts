import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { provisionTenant } from '@autoparts/api/provisioning';
import { createDb } from '@autoparts/db';
import { newId } from '@autoparts/shared';
// The API tests' in-memory .xlsx builder: the E2E file is synthetic, never customer data.
import { buildXlsx } from '../apps/api/test/xlsx';

export const SHOP_FILE = fileURLToPath(new URL('./.state/shop.json', import.meta.url));
export const LAND_FILE = fileURLToPath(new URL('./.state/land.xlsx', import.meta.url));
export const STOCK_FILE = fileURLToPath(new URL('./.state/stock.xlsx', import.meta.url));

/** Shared (platform) vehicle rows, created once per database. */
async function platformVehicle(
  db: ReturnType<typeof createDb>,
  level: string,
  name: string,
  parentId: string | null,
  extra: { name_ar?: string; year_from?: number; year_to?: number } = {},
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('vehicles')
      .select('id')
      .where('tenant_id', 'is', null)
      .where('name', '=', name);
    q = parentId === null ? q.where('parent_id', 'is', null) : q.where('parent_id', '=', parentId);
    const found = await q.executeTakeFirst();
    if (found !== undefined) return found.id;
    const id = newId();
    await trx
      .insertInto('vehicles')
      .values({ id, tenant_id: null, parent_id: parentId, level, name, ...extra })
      .execute();
    return id;
  });
}

/** Shaped like a shop's stock sheet: title row, header row, Toyota numbers, a vehicle code. */
function landFile(): Buffer {
  return buildXlsx({
    LAND: [
      ['DEMO CATALOG', null, null, null, null],
      ['Part', 'Name EN', 'Name AR', 'Car', 'Price'],
      ['04465-60320', 'Front pads OEM', 'فحمات امامية', 'LC', { n: '85' }],
      ['04465-60320', 'Front pads trade', 'فحمات امامية تجاري', 'LC', { n: '40' }],
      ['04465-60320', 'Front pads economy', 'فحمات امامية اقتصادي', 'LC', { n: '25' }],
      ['90915-YZZD4', 'Oil filter', 'مصفي زيت', 'LC', { n: '12.0000000000001' }],
    ],
  });
}

/**
 * Shaped like a stock sheet with costs in another currency (BBB) and quantities: a repeated
 * part number (its quantities add up) and a row without cost (entered before posting).
 */
function stockFile(): Buffer {
  return buildXlsx({
    STOCK: [
      ['Part', 'Name EN', 'Cost', 'Qty'],
      ['43512-60190', 'Brake disc', { n: '36.725' }, { n: '2' }],
      ['43512-60190', 'Brake disc', { n: '36.725' }, { n: '1' }],
      ['17801-38030', 'Air filter', null, { n: '4' }],
    ],
  });
}

/** Migrates the test database and provisions a fresh tenant for this run. */
export default async function globalSetup(): Promise<void> {
  const rootEnv = new URL('../.env', import.meta.url);
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const ownerUrl = process.env.TEST_DATABASE_URL;
  if (ownerUrl === undefined) throw new Error('TEST_DATABASE_URL is not set');

  execFileSync(
    'pnpm',
    [
      '--filter',
      '@autoparts/db',
      'exec',
      'dbmate',
      '--url',
      ownerUrl,
      '--migrations-dir',
      'migrations',
      '--no-dump-schema',
      'up',
    ],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );

  const shop = {
    slug: `e2e-${newId().slice(-12)}`,
    username: 'owner',
    password: 'e2e owner passphrase',
  };
  const db = createDb({ connectionString: ownerUrl, max: 1 });
  try {
    // Neutral test data: placeholder currency code and choices, not business rules.
    await provisionTenant(db, {
      slug: shop.slug,
      name: 'متجر الاختبار',
      timezone: 'UTC',
      defaultLocale: 'ar',
      functionalCurrency: { code: 'AAA', minorUnits: 2 },
      settings: { money: { roundingMode: 'HALF_EVEN' }, inventory: { allowNegativeStock: false } },
      locationName: 'المحل',
      owner: { username: shop.username, displayName: 'مالك المتجر', password: shop.password },
    });
    const type = await platformVehicle(db, 'type', 'Car', null);
    const make = await platformVehicle(db, 'make', 'Toyota', type);
    const model = await platformVehicle(db, 'model', 'Land Cruiser', make, {
      name_ar: 'لاندكروزر',
    });
    await platformVehicle(db, 'generation', 'J200', model, { year_from: 2008, year_to: 2021 });
  } finally {
    await db.destroy();
  }
  mkdirSync(new URL('./.state/', import.meta.url), { recursive: true });
  writeFileSync(SHOP_FILE, JSON.stringify(shop));
  writeFileSync(LAND_FILE, landFile());
  writeFileSync(STOCK_FILE, stockFile());
}
