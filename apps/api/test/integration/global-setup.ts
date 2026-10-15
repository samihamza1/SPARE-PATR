import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRootEnv, requireEnv } from '@autoparts/db/env';
import { resolveBinary } from 'dbmate';

const migrationsDir = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/** Brings the test database up to date. Tests provision their own tenants, so no reset. */
export default function setup(): void {
  loadRootEnv();
  execFileSync(
    resolveBinary(),
    [
      '--url',
      requireEnv('TEST_DATABASE_URL'),
      '--migrations-dir',
      migrationsDir,
      '--no-dump-schema',
      'up',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}
