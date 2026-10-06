import { isIP } from 'node:net';
import { z } from 'zod';

const envSchema = z.object({
  // The API always connects as the app role (no BYPASSRLS), never as the owner.
  APP_DATABASE_URL: z.string().min(1),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Comma-separated browser origins allowed to make state-changing requests (CSRF check).
  ALLOWED_ORIGINS: z.string().default(''),
  // Secure cookies by default; set to "false" only for plain-http local development.
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  // Behind a reverse proxy: the proxies' addresses/CIDRs (comma-separated) or a hop count,
  // so request.ip (rate limits, audit) is the real client. Default off. ADR 0017.
  TRUST_PROXY: z.string().default('false'),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  cookieSecure: boolean;
  /** false (no proxy), a number of proxy hops, or the proxies' addresses/CIDRs. */
  trustProxy: false | number | string[];
}

function isAddressOrCidr(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const [address = '', prefix] = parts;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * "true" is refused: Fastify would then trust every hop, and request.ip would be whatever
 * the client wrote first in X-Forwarded-For (ADR 0017).
 */
function parseTrustProxy(value: string): Config['trustProxy'] {
  const v = value.trim();
  const invalid = (why: string) => new Error(`Invalid API configuration: TRUST_PROXY ${why}`);
  if (v === '' || v === 'false') return false;
  if (v.toLowerCase() === 'true') {
    throw invalid(
      '"true" would let clients choose their own address; set the proxy addresses/CIDRs or the number of proxy hops',
    );
  }
  if (/^\d+$/.test(v)) {
    const hops = Number.parseInt(v, 10);
    if (hops < 1) throw invalid('hop count must be a positive integer, or "false" for no proxy');
    return hops;
  }
  const entries = v.split(',').map((e) => e.trim());
  for (const entry of entries) {
    if (!isAddressOrCidr(entry)) {
      throw invalid(
        `entry "${entry}" is not an IP address or CIDR (expected e.g. 10.0.0.5 or 10.0.0.0/8)`,
      );
    }
  }
  return entries;
}

/**
 * Fastify's `trustProxy` option for the configured value. Fastify 5 trusts nothing for a
 * plain number (it cannot check the peer), so a hop count becomes a function that trusts
 * the nearest `hops` addresses; this is only safe when the API is reachable solely
 * through the proxy (ADR 0017).
 */
export function fastifyTrustProxy(
  trustProxy: Config['trustProxy'],
): false | string[] | ((address: string, hop: number) => boolean) {
  if (typeof trustProxy !== 'number') return trustProxy;
  const hops = trustProxy;
  return (_address, hop) => hop < hops;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API configuration: ${problems.join('; ')}`);
  }
  const { APP_DATABASE_URL, API_HOST, API_PORT, ALLOWED_ORIGINS, COOKIE_SECURE, TRUST_PROXY } =
    result.data;
  const allowedOrigins = ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  for (const origin of allowedOrigins) {
    if (new URL(origin).origin !== origin) {
      throw new Error(
        `Invalid API configuration: ALLOWED_ORIGINS entry "${origin}" is not an origin`,
      );
    }
  }
  return {
    databaseUrl: APP_DATABASE_URL,
    host: API_HOST,
    port: API_PORT,
    allowedOrigins,
    cookieSecure: COOKIE_SECURE === 'true',
    trustProxy: parseTrustProxy(TRUST_PROXY),
  };
}
