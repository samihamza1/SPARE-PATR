import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

export interface ServerDeps {
  /** Resolves when the database answers a trivial query. */
  checkDatabase: () => Promise<void>;
}

export function buildServer(deps: ServerDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/health/db', async (request, reply) => {
    try {
      await deps.checkDatabase();
      return await reply.send({ status: 'ok' });
    } catch (err) {
      request.log.error({ err }, 'database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
