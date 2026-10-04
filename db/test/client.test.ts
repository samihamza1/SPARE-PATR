import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { appDb } from './helpers';

const db = appDb();
afterAll(() => db.destroy());

describe('database client', () => {
  it('returns NUMERIC as an exact decimal string, never a JS number (invariant 1)', async () => {
    const { rows } = await sql<{ amount: unknown; big: unknown }>`
      SELECT 12.50::numeric AS amount,
             12345678901234567890.123456789::numeric AS big`.execute(db);
    expect(rows).toEqual([{ amount: '12.50', big: '12345678901234567890.123456789' }]);
  });

  it('runs sessions in UTC (invariant 6)', async () => {
    const { rows } = await sql<{ tz: string }>`SELECT current_setting('TimeZone') AS tz`.execute(
      db,
    );
    expect(rows).toEqual([{ tz: 'UTC' }]);
  });
});
