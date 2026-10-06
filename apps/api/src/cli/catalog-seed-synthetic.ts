/**
 * Creates a NEW synthetic shop with a generated catalog, for performance tests and demos.
 * It never writes into an existing shop or into the shared vehicle tree.
 *
 *   pnpm catalog:seed-synthetic --parts 50000 [--seed 1]
 *
 * The shop's currency code and settings are placeholders for test data, not business rules.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createDb } from '@autoparts/db';
import { loadRootEnv, requireEnv } from '@autoparts/db/env';
import { newId } from '@autoparts/shared';
import { sql } from 'kysely';
import { seedSyntheticCatalog } from '../catalog/synthetic';
import { provisionTenant } from '../provisioning';

const { values } = parseArgs({
  options: { parts: { type: 'string' }, seed: { type: 'string' } },
  strict: true,
});
const parts = Number.parseInt(values.parts ?? '', 10);
if (!Number.isInteger(parts) || parts < 1 || parts > 1_000_000) {
  console.error('Usage: catalog:seed-synthetic --parts <1..1000000> [--seed <n>]');
  process.exit(2);
}

loadRootEnv();
const ownerDb = createDb({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
const appDb = createDb({ connectionString: requireEnv('APP_DATABASE_URL'), max: 1 });
const slug = `synthetic-${newId().slice(-8)}`;
const password = randomBytes(12).toString('base64url');
try {
  const { tenantId } = await provisionTenant(ownerDb, {
    slug,
    name: 'Synthetic catalog (test data)',
    timezone: 'UTC',
    defaultLocale: 'ar',
    functionalCurrency: { code: 'AAA', minorUnits: 2 },
    settings: { money: { roundingMode: 'HALF_EVEN' }, inventory: { allowNegativeStock: false } },
    locationName: 'Main shop',
    owner: { username: 'owner', displayName: 'Synthetic owner', password },
  });
  const started = Date.now();
  await seedSyntheticCatalog(appDb, tenantId, {
    parts,
    seed: Number.parseInt(values.seed ?? '1', 10),
    currency: 'AAA',
    minorUnits: 2,
  });
  await sql`ANALYZE parts, part_numbers, fitments, part_prices, vehicles, interchange_members`.execute(
    ownerDb,
  );
  console.log(`Seeded ${String(parts)} parts in ${String(Date.now() - started)} ms.`);
  console.log(`Shop code: ${slug}  user: owner  password: ${password}`);
} finally {
  await appDb.destroy();
  await ownerDb.destroy();
}
