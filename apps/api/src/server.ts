import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import './auth/context';
import { registerAuth } from './auth/plugin';
import type { PlatformDeps } from './auth/plugin';
import { ApiError } from './errors';
import { registerPlatformRoutes } from './routes';

export interface ServerDeps {
  /** Resolves when the database answers a trivial query. */
  checkDatabase: () => Promise<void>;
  /** Auth and platform routes. Omitted in tests that only exercise health checks. */
  platform?: PlatformDeps;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

export function buildServer(deps: ServerDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((v) => ({
        path: v.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        message: v.message ?? 'invalid',
      }));
      return reply.code(400).send({ error: { code: 'request.invalid', issues } });
    }
    const pgCode = (error as { code?: unknown }).code;
    if (pgCode === PG_UNIQUE_VIOLATION) {
      return reply.code(409).send({ error: { code: 'resource.conflict' } });
    }
    if (pgCode === PG_FOREIGN_KEY_VIOLATION) {
      // A reference to a row that does not exist in this tenant.
      return reply.code(404).send({ error: { code: 'resource.not_found' } });
    }
    if (pgCode === PG_CHECK_VIOLATION) {
      // A database rule rejected the values (e.g. deactivating the functional currency).
      return reply.code(400).send({ error: { code: 'request.invalid' } });
    }
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: 'request.rate_limited' } });
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'request.invalid' } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'server.error' } });
  });

  if (deps.platform !== undefined) {
    const platform = deps.platform;
    void app.register(cookie);
    void app.register(rateLimit, { global: false });
    void app.after(() => {
      registerAuth(app, platform);
      registerPlatformRoutes(app, platform);
    });
  }

  app.get('/health', { config: { access: 'public' } }, (_request, reply) =>
    reply.send({ status: 'ok' }),
  );

  app.get('/health/db', { config: { access: 'public' } }, async (request, reply) => {
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
