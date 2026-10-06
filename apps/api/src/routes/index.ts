import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { PlatformDeps } from '../auth/plugin';
import { ApiError } from '../errors';
import { authRoutes } from './auth';
import { importRoutes } from './catalog/imports';
import { partRoutes } from './catalog/parts';
import { priceRoutes } from './catalog/prices';
import { searchRoutes } from './catalog/search';
import { taxonomyRoutes } from './catalog/taxonomy';
import { deviceRoutes } from './devices';
import { fxRateRoutes } from './inventory/fx-rates';
import { locationRoutes } from './inventory/locations';
import { stockRoutes } from './inventory/stock';
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
  taxonomyRoutes(app, deps);
  partRoutes(app, deps);
  priceRoutes(app, deps);
  searchRoutes(app, deps);
  importRoutes(app, deps);
  locationRoutes(app, deps);
  fxRateRoutes(app, deps);
  stockRoutes(app, deps);
}
