import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Arbitrary constant key for pg_advisory_lock; serialises concurrent migrators. */
const LOCK_KEY = 7_202_610_040_001n;

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  connectionString: string;
  migrationsDir?: string;
  log?: (message: string) => void;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Read and validate migration files: NNNN_snake_name.sql, numbered 0001.. without
 * gaps or duplicates. Any other file in the directory is an error (no silent skips).
 */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => !f.startsWith('.')).sort();
  const migrations: MigrationFile[] = [];
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new MigrationError(`Unexpected file in migrations directory: ${file}`);
    const [, version = '', name = ''] = match;
    const sql = await readFile(join(dir, file), 'utf8');
    migrations.push({
      version: Number.parseInt(version, 10),
      name,
      file,
      sql,
      checksum: checksum(sql),
    });
  }
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migrations must be numbered 0001.. without gaps or duplicates; ${m.file} is out of sequence`,
      );
    }
  });
  return migrations;
}

/**
 * Forward-only migration runner. Each file runs in its own transaction, under an
 * advisory lock. Already-applied files must be unchanged (checksum); corrections
 * are new migrations, mirroring the append-only rule for business data.
 */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer     PRIMARY KEY,
        name       text        NOT NULL,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows: applied } = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');

    for (const row of applied) {
      const file = migrations[row.version - 1];
      if (file === undefined) {
        throw new MigrationError(
          `Database has migration ${String(row.version)} (${row.name}) that is missing on disk`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationError(
          `Applied migration ${file.file} was modified; write a new migration instead`,
        );
      }
    }

    const pending = migrations.slice(applied.length);
    for (const m of pending) {
      log(`applying ${m.file}`);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(`Migration ${m.file} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    if (pending.length === 0) log('database is up to date');
    return pending.map((m) => m.file);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()])
      .catch(() => undefined);
    await client.end();
  }
}
