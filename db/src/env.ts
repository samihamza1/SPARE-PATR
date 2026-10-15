import { existsSync } from 'node:fs';

/** Loads the repo-root .env if present. Variables already in the environment win. */
export function loadRootEnv(): void {
  const envFile = new URL('../../.env', import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set (see .env.example)`);
  }
  return value;
}
