import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { PlatformDeps } from '../auth/plugin';
import { ApiError } from '../errors';
import { authRoutes } from './auth';
import { deviceRoutes } from './devices';
import { roleRoutes } from './roles';
import { sessionRoutes } from './sessions';
import { settingsRoutes } from './settings';
import { userRoutes } from './users';

/**
 * One bucket per client IP shared by every unauthenticated credential endpoint, on top of
 * the per-account limits those routes declare (ADR 0007).
 */
function perIpThrottle(app: FastifyInstance, max: number): preHandlerAsyncHookHandler {
  const limiter = app.createRateLimit({
    max,
    timeWindow: 60_000,
    keyGenerator: (req) => `credential-ip|${req.ip}`,
  });
  return async (request) => {
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) throw new ApiError(429, 'request.rate_limited');
  };
}

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const credentialThrottle = perIpThrottle(app, deps.ipAttemptsPerMinute ?? 30);
  authRoutes(app, deps, credentialThrottle);
  userRoutes(app, deps);
  roleRoutes(app, deps);
  settingsRoutes(app, deps);
  deviceRoutes(app, deps, credentialThrottle);
  sessionRoutes(app, deps);
}
