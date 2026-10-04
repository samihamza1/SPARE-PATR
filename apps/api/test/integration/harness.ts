import { createDb } from '@autoparts/db';
import { loadRootEnv, requireEnv } from '@autoparts/db/env';
import { newId } from '@autoparts/shared';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { provisionTenant } from '../../src/provisioning';

loadRootEnv();

export const ORIGIN = 'https://backoffice.test';

/** Test clock; DB-side timestamps the API writes come from it, so expiry is testable. */
export class Clock {
  now = new Date();
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface TestEnv {
  app: FastifyInstance;
  clock: Clock;
  ownerDb: ReturnType<typeof createDb>;
  appDb: ReturnType<typeof createDb>;
}

/** One app + clock per test file, closed afterwards. */
export function setupEnv(): TestEnv {
  const ownerDb = createDb({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 2 });
  const appDb = createDb({ connectionString: requireEnv('TEST_APP_DATABASE_URL'), max: 4 });
  const clock = new Clock();
  const app = buildServer(
    {
      checkDatabase: () => Promise.resolve(),
      platform: {
        db: appDb,
        allowedOrigins: [ORIGIN],
        cookieSecure: true,
        now: () => clock.now,
        // Tests sign in many times a minute from one address; the per-IP limit has its
        // own test below with a small value.
        ipAttemptsPerMinute: 10_000,
      },
    },
    { logger: process.env.TEST_LOG === '1' ? { level: 'error' } : false },
  );
  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await ownerDb.destroy();
  });
  return { app, clock, ownerDb, appDb };
}

export const OWNER_PASSWORD = 'owner passphrase 1';

export interface Shop {
  slug: string;
  tenantId: string;
  ownerUserId: string;
}

/** Neutral test data: placeholder currency code and choices, not business rules. */
export async function provisionShop(env: TestEnv): Promise<Shop> {
  const slug = `shop-${newId().slice(-12)}`;
  const { tenantId, ownerUserId } = await provisionTenant(
    env.ownerDb,
    {
      slug,
      name: `Shop ${slug}`,
      timezone: 'UTC',
      defaultLocale: 'ar',
      functionalCurrency: { code: 'AAA', minorUnits: 2 },
      settings: { money: { roundingMode: 'HALF_EVEN' }, inventory: { allowNegativeStock: false } },
      owner: { username: 'owner', displayName: 'Owner', password: OWNER_PASSWORD },
    },
    env.clock.now,
  );
  return { slug, tenantId, ownerUserId };
}

/** A browser-like client: keeps the session cookie and sends the allowed Origin. */
export class Client {
  cookie: string | undefined;
  constructor(
    private readonly app: FastifyInstance,
    private readonly origin: string | null = ORIGIN,
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      headers: {
        ...(this.origin !== null && { origin: this.origin }),
        ...(this.cookie !== undefined && { cookie: `sid=${this.cookie}` }),
        ...headers,
      },
      ...(body !== undefined && { payload: body as object }),
    });
    const set = res.cookies.find((c) => c.name === 'sid');
    if (set !== undefined) this.cookie = set.value === '' ? undefined : set.value;
    return res;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('POST', url, body ?? {}, headers);
  put = (url: string, body: unknown) => this.request('PUT', url, body);
  patch = (url: string, body: unknown) => this.request('PATCH', url, body);

  async login(slug: string, username: string, password: string, headers?: Record<string, string>) {
    return this.post('/auth/login', { tenant: slug, username, password }, headers);
  }
}

export async function loggedIn(
  env: TestEnv,
  shop: Shop,
  username = 'owner',
  password = OWNER_PASSWORD,
) {
  const client = new Client(env.app);
  const res = await client.login(shop.slug, username, password);
  if (res.statusCode !== 200)
    throw new Error(`login failed: ${String(res.statusCode)} ${res.body}`);
  return client;
}

export const errorCode = (res: LightMyRequestResponse): unknown =>
  res.json<{ error?: { code?: unknown } }>().error?.code;
