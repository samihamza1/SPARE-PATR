import { loadEnv, requireEnv } from '../config.js';
import { migrate } from '../migrate.js';

loadEnv();
await migrate({
  connectionString: requireEnv('OWNER_DATABASE_URL'),
  log: (message) => {
    console.log(message);
  },
});
