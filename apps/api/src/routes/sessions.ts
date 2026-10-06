import { auditQuerySchema, idParamsSchema } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import type { PlatformDeps } from '../auth/plugin';
import { authOf } from '../auth/plugin';
import { revokeSessions } from '../auth/sessions';
import { forbidden, notFound } from '../errors';
import { seesCost, withoutCost } from '../inventory/cost-view';
import type { Trx } from './common';
import { actorOf, inTenant, iso } from './common';

async function loadSessions(trx: Trx, userId: string, currentId: string) {
  const rows = await trx
    .selectFrom('sessions')
    .select([
      'id',
      'user_id',
      'created_at',
      'last_seen_at',
      'expires_at',
      'revoked_at',
      'ip',
      'user_agent',
    ])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(100)
    .execute();
  return rows.map((s) => ({
    id: s.id,
    userId: s.user_id,
    createdAt: s.created_at.toISOString(),
    lastSeenAt: s.last_seen_at.toISOString(),
    expiresAt: s.expires_at.toISOString(),
    revokedAt: iso(s.revoked_at),
    ip: s.ip,
    userAgent: s.user_agent,
    current: s.id === currentId,
  }));
}

export function sessionRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/me/sessions', { config: { access: 'authenticated' } }, (request) =>
    inTenant(deps, request, (trx, auth) => loadSessions(trx, auth.userId, auth.sessionId)),
  );

  r.get(
    '/users/:id/sessions',
    { schema: { params: idParamsSchema }, config: { access: 'sessions.manage' } },
    (request) =>
      inTenant(deps, request, (trx, auth) => loadSessions(trx, request.params.id, auth.sessionId)),
  );

  // Your own sessions, or anyone's with sessions.manage.
  r.post(
    '/sessions/:id/revoke',
    { schema: { params: idParamsSchema }, config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = authOf(request);
      const now = deps.now();
      await inTenant(deps, request, async (trx) => {
        const session = await trx
          .selectFrom('sessions')
          .select(['id', 'user_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (session === undefined) throw notFound();
        if (session.user_id !== auth.userId && !auth.permissions.has('sessions.manage')) {
          throw forbidden();
        }
        await revokeSessions(trx, { sessionId: session.id }, 'revoked', now);
        await audit(
          trx,
          actorOf(request),
          {
            action: 'session.revoke',
            entityType: 'session',
            entityId: session.id,
            after: { userId: session.user_id },
          },
          now,
        );
      });
      return reply.code(204).send();
    },
  );

  r.get(
    '/audit-log',
    { schema: { querystring: auditQuerySchema }, config: { access: 'audit.read' } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const q = request.query;
        // Supervisors read the log; only cost.view shows stock values in it (ADR 0022).
        const hide = !seesCost(auth);
        let query = trx
          .selectFrom('audit_log')
          .select([
            'id',
            'occurred_at',
            'actor_user_id',
            'action',
            'entity_type',
            'entity_id',
            'before',
            'after',
            'reason',
          ])
          .orderBy('id', 'desc')
          .limit(q.limit);
        if (q.entityType !== undefined) query = query.where('entity_type', '=', q.entityType);
        if (q.entityId !== undefined) query = query.where('entity_id', '=', q.entityId);
        if (q.actorUserId !== undefined) query = query.where('actor_user_id', '=', q.actorUserId);
        if (q.before !== undefined) query = query.where('id', '<', q.before);
        return (await query.execute()).map((e) => ({
          id: e.id,
          occurredAt: e.occurred_at.toISOString(),
          actorUserId: e.actor_user_id,
          action: e.action,
          entityType: e.entity_type,
          entityId: e.entity_id,
          before: hide ? withoutCost(e.before) : e.before,
          after: hide ? withoutCost(e.after) : e.after,
          reason: e.reason,
        }));
      }),
  );
}
