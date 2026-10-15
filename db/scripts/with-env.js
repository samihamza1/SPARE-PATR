// Runs a command with the repo-root .env loaded when it exists. Variables already set in
// the environment win, so CI can pass them directly without a file.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('usage: node scripts/with-env.js <command> [args...]');
  process.exit(2);
}
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
