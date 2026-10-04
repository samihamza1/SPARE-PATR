import { z } from 'zod';

const envSchema = z.object({
  // The API always connects as the app role (no BYPASSRLS), never as the owner.
  APP_DATABASE_URL: z.string().min(1),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API configuration: ${problems.join('; ')}`);
  }
  const { APP_DATABASE_URL, API_HOST, API_PORT } = result.data;
  return { databaseUrl: APP_DATABASE_URL, host: API_HOST, port: API_PORT };
}
