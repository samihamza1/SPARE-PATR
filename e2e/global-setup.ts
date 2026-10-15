import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { provisionTenant } from '@autoparts/api/provisioning';
import { createDb } from '@autoparts/db';
import { newId } from '@autoparts/shared';

export const SHOP_FILE = fileURLToPath(new URL('./.state/shop.json', import.meta.url));

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
      owner: { username: shop.username, displayName: 'مالك المتجر', password: shop.password },
    });
  } finally {
    await db.destroy();
  }
  mkdirSync(new URL('./.state/', import.meta.url), { recursive: true });
  writeFileSync(SHOP_FILE, JSON.stringify(shop));
}
