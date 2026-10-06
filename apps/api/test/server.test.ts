import { describe, expect, it } from 'vitest';
import { fastifyTrustProxy, loadConfig } from '../src/config';
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
      trustProxy: false,
    });
  });

  it('parses TRUST_PROXY as off, a hop count or an address/CIDR list', () => {
    const base = { APP_DATABASE_URL: 'x' };
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: ' ' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(
      loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1,::1,fd00::/8' }).trustProxy,
    ).toEqual(['10.0.0.0/8', '127.0.0.1', '::1', 'fd00::/8']);
  });

  it('refuses TRUST_PROXY=true and anything that is not a hop count or addresses', () => {
    const base = { APP_DATABASE_URL: 'x' };
    // "true" would trust every hop, so the client could choose request.ip.
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY.*true/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'TRUE' })).toThrow(/TRUST_PROXY/);
    for (const value of [
      '0',
      '-1',
      '1.5',
      'loopback',
      '10.0.0.0/33',
      '::1/129',
      '10.0.0.1,',
      'x/8',
      '10.0.0.0/8/8',
      'proxy.local',
    ]) {
      expect(() => loadConfig({ ...base, TRUST_PROXY: value }), value).toThrow(/TRUST_PROXY/);
    }
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

describe('trustProxy', () => {
  async function clientIp(trustProxy: string, forwardedFor: string): Promise<string> {
    const config = loadConfig({ APP_DATABASE_URL: 'x', TRUST_PROXY: trustProxy });
    const app = buildServer(healthyDb, { trustProxy: fastifyTrustProxy(config.trustProxy) });
    app.get('/ip', { config: { access: 'public' } }, (request) => ({ ip: request.ip }));
    // inject() connects from 127.0.0.1, standing in for the reverse proxy.
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': forwardedFor },
    });
    await app.close();
    return res.json<{ ip: string }>().ip;
  }

  it('takes the client from the trusted proxy only, never from what the client wrote', async () => {
    // The client sent its own X-Forwarded-For (spoof); the proxy appended the real address.
    const header = '203.0.113.66, 198.51.100.7';
    expect(await clientIp('127.0.0.1', header)).toBe('198.51.100.7');
    expect(await clientIp('127.0.0.0/8,10.0.0.0/8', header)).toBe('198.51.100.7');
    expect(await clientIp('1', header)).toBe('198.51.100.7');
    expect(await clientIp('false', header)).toBe('127.0.0.1');
    // An address list that does not include the peer trusts nothing.
    expect(await clientIp('10.0.0.1', header)).toBe('127.0.0.1');
  });
});
