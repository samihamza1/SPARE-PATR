import { spawnSync } from 'node:child_process';

import { loadEnv, requireEnv } from '../config.js';

// Generates src/generated/db.ts from the live schema (SQL is the source of truth).
// Pass --verify to fail when the committed types are stale (used in CI).
loadEnv();
requireEnv('OWNER_DATABASE_URL');
const result = spawnSync(
  'kysely-codegen',
  [
    '--dialect=postgres',
    '--url=env(OWNER_DATABASE_URL)',
    '--out-file=src/generated/db.ts',
    '--exclude-pattern=schema_migrations',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);
