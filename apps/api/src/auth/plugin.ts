import type { DB } from '@autoparts/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { ApiError, forbidden, unauthenticated } from '../errors';
import type { AuthContext } from './context';
import { SESSION_COOKIE, authenticate } from './sessions';

export interface PlatformDeps {
  /** Connects as autoparts_app. */
  db: Kysely<DB>;
  /** Browser origins allowed to send state-changing requests with the session cookie. */
  allowedOrigins: readonly string[];
  /** false only for local http development. */
  cookieSecure: boolean;
  now: () => Date;
  /**
   * Credential attempts (login, device enrollment) allowed per client IP per minute,
   * across all accounts. Caps the Argon2 work one address can trigger. Default 30.
   */
  ipAttemptsPerMinute?: number;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Route access control (ADR 0007):
 * - every route must declare config.access, or the server refuses to start;
 * - non-public routes need a valid session, and a permission when one is named;
 * - state-changing requests from a browser must come from an allowed Origin (CSRF, on top
 *   of SameSite=Strict). A request carrying the session cookie without an Origin is refused.
 */
export function registerAuth(app: FastifyInstance, deps: PlatformDeps): void {
  app.decorateRequest('auth', null);

  app.addHook('onRoute', (route) => {
    if (route.config?.access === undefined) {
      throw new Error(`Route ${String(route.method)} ${route.url} must declare config.access`);
    }
  });

  app.addHook('onRequest', async (request) => {
    if (UNSAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const hasSession = request.cookies[SESSION_COOKIE] !== undefined;
      const allowed = origin === undefined ? !hasSession : deps.allowedOrigins.includes(origin);
      if (!allowed) throw new ApiError(403, 'auth.bad_origin');
    }

    // Unmatched routes (404) have no access config and fall through to the not-found handler.
    const access = request.routeOptions.config.access;
    if (access === undefined || access === 'public') return;

    request.auth = await authenticate(deps.db, request.cookies[SESSION_COOKIE], deps.now());
    if (request.auth === null) throw unauthenticated();
    if (access !== 'authenticated' && !request.auth.permissions.has(access)) throw forbidden();
  });
}

/** The caller's auth context; only valid on non-public routes. */
export function authOf(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw unauthenticated();
  return request.auth;
}
