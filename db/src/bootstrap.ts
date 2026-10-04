import pg from 'pg';

import { APP_ROLE, OWNER_ROLE, databaseName, withDatabase } from './config.js';

export interface BootstrapOptions {
  /** Superuser connection (any database on the target server). */
  adminUrl: string;
  ownerUrl: string;
  appUrl: string;
  /** Drop and recreate the database first. Development and tests only. */
  recreate?: boolean;
}

function credentials(connectionString: string, expectedRole: string): string {
  const url = new URL(connectionString);
  const user = decodeURIComponent(url.username);
  if (user !== expectedRole) {
    throw new Error(`Connection URL must use role ${expectedRole}, got ${user || '(none)'}`);
  }
  const password = decodeURIComponent(url.password);
  if (password === '') throw new Error(`No password given for role ${expectedRole}`);
  return password;
}

/**
 * Cluster-level setup that migrations cannot do: roles, the database and schema
 * privileges. Idempotent. Runs as a superuser, never from the application.
 */
export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const ownerPassword = credentials(options.ownerUrl, OWNER_ROLE);
  const appPassword = credentials(options.appUrl, APP_ROLE);
  const database = databaseName(options.ownerUrl);
  if (databaseName(options.appUrl) !== database) {
    throw new Error('OWNER_DATABASE_URL and APP_DATABASE_URL must point to the same database');
  }

  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  try {
    const ident = (s: string) => admin.escapeIdentifier(s);
    const literal = (s: string) => admin.escapeLiteral(s);
    for (const [role, password] of [
      [OWNER_ROLE, ownerPassword],
      [APP_ROLE, appPassword],
    ] as const) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const verb = rowCount === 0 ? 'CREATE' : 'ALTER';
      await admin.query(
        `${verb} ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)}
           NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }

    if (options.recreate === true) {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
    }
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (rowCount === 0) {
      await admin.query(
        `CREATE DATABASE ${ident(database)} OWNER ${ident(OWNER_ROLE)} ENCODING 'UTF8' TEMPLATE template0`,
      );
    }
  } finally {
    await admin.end();
  }

  const adminDb = new pg.Client({ connectionString: withDatabase(options.adminUrl, database) });
  await adminDb.connect();
  try {
    const owner = adminDb.escapeIdentifier(OWNER_ROLE);
    const app = adminDb.escapeIdentifier(APP_ROLE);
    const db = adminDb.escapeIdentifier(database);
    await adminDb.query(`
      REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
      GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${owner};
      GRANT CONNECT ON DATABASE ${db} TO ${app};
      ALTER SCHEMA public OWNER TO ${owner};
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${app};
      ALTER DATABASE ${db} SET timezone TO 'UTC';
    `);
  } finally {
    await adminDb.end();
  }
}
