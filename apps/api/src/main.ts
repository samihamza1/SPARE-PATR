import { createDb } from '@autoparts/db';
import { sql } from 'kysely';
import { fastifyTrustProxy, loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig();
const db = createDb({ connectionString: config.databaseUrl, applicationName: 'autoparts-api' });

const app = buildServer(
  {
    checkDatabase: async () => {
      await sql`SELECT 1`.execute(db);
    },
    platform: {
      db,
      allowedOrigins: config.allowedOrigins,
      cookieSecure: config.cookieSecure,
      now: () => new Date(),
    },
  },
  // TRUST_PROXY makes request.ip (rate limits, audit) the client, not the proxy.
  { logger: true, trustProxy: fastifyTrustProxy(config.trustProxy) },
);
app.addHook('onClose', () => db.destroy());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: config.host, port: config.port });
