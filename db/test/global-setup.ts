import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from 'dbmate';
import { loadRootEnv, requireEnv } from '../src/env';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Recreates the test database from scratch, then checks every down migration by rolling
 * all the way back and migrating up again.
 */
export default function setup(): void {
  loadRootEnv();
  const url = requireEnv('TEST_DATABASE_URL');
  const dbmate = (command: string) => {
    execFileSync(
      resolveBinary(),
      ['--url', url, '--migrations-dir', migrationsDir, '--no-dump-schema', command],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  };

  dbmate('drop');
  dbmate('up');
  const migrationCount = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length;
  for (let i = 0; i < migrationCount; i++) dbmate('rollback');
  dbmate('up');
}
