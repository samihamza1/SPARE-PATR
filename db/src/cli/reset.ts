import { bootstrap } from '../bootstrap.js';
import { loadEnv, requireEnv } from '../config.js';
import { migrate } from '../migrate.js';

loadEnv();
if (process.env['NODE_ENV'] === 'production') {
  throw new Error('db:reset is for development only');
}
await bootstrap({
  adminUrl: requireEnv('ADMIN_DATABASE_URL'),
  ownerUrl: requireEnv('OWNER_DATABASE_URL'),
  appUrl: requireEnv('APP_DATABASE_URL'),
  recreate: true,
});
await migrate({
  connectionString: requireEnv('OWNER_DATABASE_URL'),
  log: (message) => {
    console.log(message);
  },
});
