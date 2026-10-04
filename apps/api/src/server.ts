import { createDatabase, loadEnv } from '@autoparts/db';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

loadEnv();
const config = loadConfig();
const db = createDatabase({ connectionString: config.APP_DATABASE_URL });
const app = buildApp({ db, logLevel: config.LOG_LEVEL });

const shutdown = async () => {
  await app.close();
  await db.destroy();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
