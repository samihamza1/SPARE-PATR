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
  // Behind a reverse proxy: "true", a hop count, or a comma-separated list of proxy
  // addresses/CIDRs, so request.ip (rate limits, audit) is the real client. Default off.
  TRUST_PROXY: z.string().default('false'),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean | number | string;
}

function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v;
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
