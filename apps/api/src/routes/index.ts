import type { FastifyInstance } from 'fastify';
import type { PlatformDeps } from '../auth/plugin';
import { authRoutes } from './auth';
import { deviceRoutes } from './devices';
import { roleRoutes } from './roles';
import { sessionRoutes } from './sessions';
import { settingsRoutes } from './settings';
import { userRoutes } from './users';

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  authRoutes(app, deps);
  userRoutes(app, deps);
  roleRoutes(app, deps);
  settingsRoutes(app, deps);
  deviceRoutes(app, deps);
  sessionRoutes(app, deps);
}
