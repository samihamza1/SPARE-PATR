import { sql } from 'kysely';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Database } from '@autoparts/db';

export interface AppOptions {
  db: Database;
  logLevel?: string;
}

export function buildApp({ db, logLevel = 'info' }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });

  app.get('/health', async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
