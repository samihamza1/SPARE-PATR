import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OWNER_ROLE, withDatabase } from '../src/config.js';
import { MigrationError, loadMigrations, migrate } from '../src/migrate.js';
import { urls } from './helpers.js';

const SCRATCH_DB = 'autoparts_test_migrate';

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urls.adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let dir: string;
const connectionString = withDatabase(urls.ownerUrl, SCRATCH_DB);

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SCRATCH_DB} OWNER ${OWNER_ROLE}`);
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await admin((c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
});

const write = (file: string, sql: string) => writeFile(join(dir, file), sql);

describe('migration runner', () => {
  it('applies files in order and records them; a second run is a no-op', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int);');
    await write('0002_second.sql', 'INSERT INTO t VALUES (1), (2);');
    expect(await migrate({ connectionString, migrationsDir: dir })).toEqual([
      '0001_first.sql',
      '0002_second.sql',
    ]);
    expect(await migrate({ connectionString, migrationsDir: dir })).toEqual([]);
    expect(await query('SELECT count(*)::int AS n FROM t')).toEqual([{ n: 2 }]);
    expect(await query('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ]);
  });

  it('applies only new files on later runs', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int);');
    await migrate({ connectionString, migrationsDir: dir });
    await write('0002_second.sql', 'ALTER TABLE t ADD COLUMN w int;');
    expect(await migrate({ connectionString, migrationsDir: dir })).toEqual(['0002_second.sql']);
  });

  it('refuses to run when an applied migration was edited', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int);');
    await migrate({ connectionString, migrationsDir: dir });
    await write('0001_first.sql', 'CREATE TABLE t (v bigint);');
    await expect(migrate({ connectionString, migrationsDir: dir })).rejects.toThrow(
      /0001_first\.sql was modified/,
    );
  });

  it('refuses when the database has a migration missing on disk', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int);');
    await write('0002_second.sql', 'SELECT 1;');
    await migrate({ connectionString, migrationsDir: dir });
    await rm(join(dir, '0002_second.sql'));
    await expect(migrate({ connectionString, migrationsDir: dir })).rejects.toThrow(
      /missing on disk/,
    );
  });

  it('rolls back a failing migration completely and stops', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int);');
    await write('0002_broken.sql', 'CREATE TABLE u (v int); SELECT * FROM does_not_exist;');
    await write('0003_after.sql', 'CREATE TABLE w (v int);');
    await expect(migrate({ connectionString, migrationsDir: dir })).rejects.toThrow(MigrationError);
    const tables = await query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.name)).toEqual(['schema_migrations', 't']);
  });

  it('serialises concurrent runs with an advisory lock', async () => {
    await write('0001_first.sql', 'CREATE TABLE t (v int); SELECT pg_sleep(0.2);');
    const results = await Promise.all([
      migrate({ connectionString, migrationsDir: dir }),
      migrate({ connectionString, migrationsDir: dir }),
    ]);
    expect(results.flat()).toEqual(['0001_first.sql']);
  });
});

describe('loadMigrations', () => {
  it.each([
    [['0001_a.sql', '0003_c.sql'], /out of sequence/],
    [['0001_a.sql', '0001_b.sql'], /out of sequence/],
    [['0002_a.sql'], /out of sequence/],
    [['0001_a.sql', 'notes.txt'], /Unexpected file/],
    [['1_a.sql'], /Unexpected file/],
    [['0001_CamelCase.sql'], /Unexpected file/],
  ])('rejects %j', async (files, error) => {
    for (const f of files) await write(f, 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(error);
  });

  it('the real migrations directory is valid', async () => {
    const migrations = await loadMigrations(join(import.meta.dirname, '..', 'migrations'));
    expect(migrations.length).toBeGreaterThan(0);
  });
});
