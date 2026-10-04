import { afterAll, describe, expect, it, inject } from 'vitest';

import { createDatabase } from '@autoparts/db';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const urls = inject('db');

describe('GET /health', () => {
  const db = createDatabase({ connectionString: urls.appUrl, max: 1 });
  const app = buildApp({ db, logLevel: 'silent' });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('reports ok when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports 503 when the database is unreachable', async () => {
    const down = createDatabase({
      connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none',
      max: 1,
    });
    const broken = buildApp({ db: down, logLevel: 'silent' });
    const res = await broken.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    await broken.close();
    await down.destroy();
  });
});

describe('loadConfig', () => {
  it('validates the environment', () => {
    expect(() => loadConfig({})).toThrow(/APP_DATABASE_URL/);
    expect(loadConfig({ APP_DATABASE_URL: 'postgres://u:p@h:5432/d', PORT: '8080' })).toMatchObject(
      {
        PORT: 8080,
        HOST: '0.0.0.0',
      },
    );
  });
});
