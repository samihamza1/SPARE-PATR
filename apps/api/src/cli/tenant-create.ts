/**
 * Provisions a tenant. Every value is required; nothing money, tax or locale related is
 * defaulted. Runs as the owner role (DATABASE_URL).
 *
 *   pnpm tenant:create --slug sky-motors --name "Sky Motors" --timezone <IANA zone> \
 *     --locale ar --currency <ISO code> --minor-units <0-4> [--cash-increment <decimal>] \
 *     --rounding <HALF_UP|HALF_EVEN|...> --negative-stock <allow|deny> \
 *     --owner-username <name> --owner-name "<display name>"
 *
 * The owner password is read from a hidden prompt, or from TENANT_OWNER_PASSWORD when
 * stdin is not a terminal (CI, scripts).
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createDb } from '@autoparts/db';
import { loadRootEnv, requireEnv } from '@autoparts/db/env';
import { provisionTenant } from '../provisioning';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(
      rl,
    );
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      write(s.startsWith(prompt) ? prompt : '');
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    timezone: { type: 'string' },
    locale: { type: 'string' },
    currency: { type: 'string' },
    'minor-units': { type: 'string' },
    'cash-increment': { type: 'string' },
    rounding: { type: 'string' },
    'negative-stock': { type: 'string' },
    'owner-username': { type: 'string' },
    'owner-name': { type: 'string' },
  },
  strict: true,
});

const required = (key: keyof typeof values): string => {
  const value = values[key];
  if (value === undefined || value === '') {
    console.error(`Missing required option --${key}`);
    process.exit(2);
  }
  return value;
};

const negativeStock = required('negative-stock');
if (negativeStock !== 'allow' && negativeStock !== 'deny') {
  console.error('--negative-stock must be "allow" or "deny"');
  process.exit(2);
}

loadRootEnv();
const password = process.stdin.isTTY
  ? await readHidden('Owner password: ')
  : requireEnv('TENANT_OWNER_PASSWORD');

const db = createDb({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
try {
  const result = await provisionTenant(db, {
    slug: required('slug'),
    name: required('name'),
    timezone: required('timezone'),
    defaultLocale: required('locale'),
    functionalCurrency: {
      code: required('currency'),
      minorUnits: Number.parseInt(required('minor-units'), 10),
      cashIncrement: values['cash-increment'] ?? null,
    },
    settings: {
      money: { roundingMode: required('rounding') as never },
      inventory: { allowNegativeStock: negativeStock === 'allow' },
    },
    owner: {
      username: required('owner-username'),
      displayName: required('owner-name'),
      password,
    },
  });
  console.log(`Tenant created: ${result.tenantId} (owner user ${result.ownerUserId})`);
} finally {
  await db.destroy();
}
