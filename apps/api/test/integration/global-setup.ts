import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRootEnv, requireEnv } from '@autoparts/db/env';
import { resolveBinary } from 'dbmate';

const migrationsDir = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/**
 * Recreates the test database. Tests provision their own tenants, but the shared (platform)
 * vehicles they add are visible to every tenant, so a second run on the same database would
 * find the first run's rows too.
 */
export default function setup(): void {
  loadRootEnv();
  const url = requireEnv('TEST_DATABASE_URL');
  for (const command of ['drop', 'up']) {
    execFileSync(
      resolveBinary(),
      ['--url', url, '--migrations-dir', migrationsDir, '--no-dump-schema', command],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }
}
