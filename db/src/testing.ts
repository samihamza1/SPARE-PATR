import { bootstrap } from './bootstrap.js';
import { loadEnv, requireEnv, withDatabase } from './config.js';
import { migrate } from './migrate.js';

export interface TestDatabase {
  adminUrl: string;
  ownerUrl: string;
  appUrl: string;
}

/**
 * Recreate a dedicated, fully migrated database for one test project. Uses the same
 * roles as development (roles are cluster-wide) and a separate database name.
 */
export async function prepareTestDatabase(database: string): Promise<TestDatabase> {
  loadEnv();
  const adminUrl = requireEnv('ADMIN_DATABASE_URL');
  const ownerUrl = withDatabase(requireEnv('OWNER_DATABASE_URL'), database);
  const appUrl = withDatabase(requireEnv('APP_DATABASE_URL'), database);
  await bootstrap({ adminUrl, ownerUrl, appUrl, recreate: true });
  await migrate({ connectionString: ownerUrl });
  return { adminUrl, ownerUrl, appUrl };
}
