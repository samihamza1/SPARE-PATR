import type { Permission } from '@autoparts/shared';

/** Who is calling, resolved from the session cookie on every request. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  deviceId: string | null;
  permissions: ReadonlySet<Permission>;
}

/**
 * Every route declares its access in `config.access`; a route without one fails at
 * startup (see registerAuth). 'authenticated' means any signed-in user.
 */
export type Access = 'public' | 'authenticated' | Permission;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}
