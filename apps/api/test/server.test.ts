import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer } from '../src/server';

const healthyDb = { checkDatabase: () => Promise.resolve() };

describe('health endpoints', () => {
  it('GET /health reports the process is up', async () => {
    const app = buildServer(healthyDb);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /health/db reports a reachable database', async () => {
    const app = buildServer(healthyDb);
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /health/db returns 503 without leaking error details', async () => {
    const app = buildServer({
      checkDatabase: () => Promise.reject(new Error('password authentication failed')),
    });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});

describe('loadConfig', () => {
  it('reads the app role connection string and defaults host and port', () => {
    expect(loadConfig({ APP_DATABASE_URL: 'postgres://app@db/autoparts' })).toEqual({
      databaseUrl: 'postgres://app@db/autoparts',
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: [],
      cookieSecure: true,
    });
  });

  it('parses allowed origins and the cookie flag', () => {
    expect(
      loadConfig({
        APP_DATABASE_URL: 'x',
        ALLOWED_ORIGINS: 'http://localhost:5173, https://bo.example.com',
        COOKIE_SECURE: 'false',
      }),
    ).toMatchObject({
      allowedOrigins: ['http://localhost:5173', 'https://bo.example.com'],
      cookieSecure: false,
    });
    expect(() =>
      loadConfig({ APP_DATABASE_URL: 'x', ALLOWED_ORIGINS: 'http://a.com/path' }),
    ).toThrow(/ALLOWED_ORIGINS/);
  });

  it('fails fast on missing or invalid settings', () => {
    expect(() => loadConfig({})).toThrow(/APP_DATABASE_URL/);
    expect(() => loadConfig({ APP_DATABASE_URL: 'x', API_PORT: 'eighty' })).toThrow(/API_PORT/);
  });
});
