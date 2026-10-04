import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fixed role names; migrations GRANT to these. Passwords come from the connection URLs. */
export const OWNER_ROLE = 'autoparts_owner';
export const APP_ROLE = 'autoparts_app';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));

/** Load the repo-root .env (if present) without overriding variables already set. */
export function loadEnv(): void {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

/** Same server and credentials, different database name. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function databaseName(connectionString: string): string {
  const name = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (name === '') throw new Error('Connection string has no database name');
  return name;
}
