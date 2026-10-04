import { bootstrap } from '../bootstrap.js';
import { loadEnv, requireEnv } from '../config.js';

loadEnv();
await bootstrap({
  adminUrl: requireEnv('ADMIN_DATABASE_URL'),
  ownerUrl: requireEnv('OWNER_DATABASE_URL'),
  appUrl: requireEnv('APP_DATABASE_URL'),
});
console.log('bootstrap complete');
