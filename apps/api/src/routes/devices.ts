import { withTenant } from '@autoparts/db';
import {
  createDeviceSchema,
  enrollDeviceSchema,
  idParamsSchema,
  setDeviceLocationSchema,
} from '@autoparts/shared';
import type { Device } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { audit } from '../audit';
import type { PlatformDeps } from '../auth/plugin';
import { revokeSessions } from '../auth/sessions';
import { ApiError, conflict, notFound } from '../errors';
import { enrollmentCode, normalizeEnrollmentCode, randomSecret, sha256 } from '../security/crypto';
import type { Trx } from './common';
import { actorOf, inTenant, iso } from './common';
import { resolveTenant } from './auth';

/** How long a one-time enrollment code stays valid (ADR 0011). */
const ENROLLMENT_TTL_MS = 30 * 60_000;
const ENROLL_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

async function loadDevices(trx: Trx, id?: string): Promise<Device[]> {
  let q = trx
    .selectFrom('devices')
    .select([
      'id',
      'name',
      'location_id',
      'enrolled_at',
      'enrollment_expires_at',
      'last_seen_at',
      'revoked_at',
    ])
    .orderBy('name');
  if (id !== undefined) q = q.where('id', '=', id);
  return (await q.execute()).map((d) => ({
    id: d.id,
    name: d.name,
    locationId: d.location_id,
    enrolledAt: iso(d.enrolled_at),
    enrollmentExpiresAt: d.enrolled_at === null ? iso(d.enrollment_expires_at) : null,
    lastSeenAt: iso(d.last_seen_at),
    revokedAt: iso(d.revoked_at),
  }));
}

async function loadDevice(trx: Trx, id: string): Promise<Device> {
  const [device] = await loadDevices(trx, id);
  if (device === undefined) throw notFound();
  return device;
}

/**
 * A selling device belongs to an active shop (ADR 0018). Without a choice, the default
 * shop; a tenant without locations yet leaves it unset.
 */
async function deviceLocation(trx: Trx, requested: string | undefined): Promise<string | null> {
  let q = trx
    .selectFrom('locations')
    .select(['id', 'kind', 'archived_at'])
    .where('archived_at', 'is', null);
  q = requested === undefined ? q.where('is_default', '=', true) : q.where('id', '=', requested);
  const location = await q.executeTakeFirst();
  if (location === undefined) {
    if (requested === undefined) return null;
    throw notFound();
  }
  if (location.kind !== 'shop') throw new ApiError(409, 'location.not_a_shop');
  return location.id;
}

/** Shown as XXXXX-XXXXX; normalizeEnrollmentCode() undoes the grouping. */
const display = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

export function deviceRoutes(
  app: FastifyInstance,
  deps: PlatformDeps,
  credentialThrottle: preHandlerAsyncHookHandler,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const access = 'devices.manage' as const;

  r.get('/devices', { config: { access } }, (request) =>
    inTenant(deps, request, (trx) => loadDevices(trx)),
  );

  r.post(
    '/devices',
    { schema: { body: createDeviceSchema }, config: { access } },
    async (request, reply) => {
      const code = enrollmentCode();
      const now = deps.now();
      const device = await inTenant(deps, request, async (trx, auth) => {
        await trx
          .insertInto('devices')
          .values({
            id: request.body.id,
            tenant_id: auth.tenantId,
            name: request.body.name,
            location_id: await deviceLocation(trx, request.body.locationId),
            created_by: auth.userId,
            created_at: now,
            enrollment_code_hash: sha256(code),
            enrollment_expires_at: new Date(now.getTime() + ENROLLMENT_TTL_MS),
          })
          .execute();
        const created = await loadDevice(trx, request.body.id);
        await audit(
          trx,
          actorOf(request),
          { action: 'device.create', entityType: 'device', entityId: created.id, after: created },
          now,
        );
        return created;
      });
      return reply.code(201).send({ device, enrollmentCode: display(code) });
    },
  );

  r.patch(
    '/devices/:id',
    { schema: { params: idParamsSchema, body: setDeviceLocationSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const before = await loadDevice(trx, id);
        if (before.revokedAt !== null) throw conflict();
        const locationId = await deviceLocation(trx, request.body.locationId);
        if (locationId === before.locationId) return before;
        await trx
          .updateTable('devices')
          .set({ location_id: locationId })
          .where('id', '=', id)
          .execute();
        const after = await loadDevice(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'device.location', entityType: 'device', entityId: id, before, after },
          deps.now(),
        );
        return after;
      }),
  );

  r.post(
    '/devices/:id/enrollment-code',
    { schema: { params: idParamsSchema }, config: { access } },
    async (request) => {
      const code = enrollmentCode();
      const now = deps.now();
      const device = await inTenant(deps, request, async (trx) => {
        const { id } = request.params;
        const before = await loadDevice(trx, id);
        if (before.enrolledAt !== null || before.revokedAt !== null) throw conflict();
        await trx
          .updateTable('devices')
          .set({
            enrollment_code_hash: sha256(code),
            enrollment_expires_at: new Date(now.getTime() + ENROLLMENT_TTL_MS),
          })
          .where('id', '=', id)
          .execute();
        const after = await loadDevice(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'device.new_code', entityType: 'device', entityId: id, before, after },
          now,
        );
        return after;
      });
      return { device, enrollmentCode: display(code) };
    },
  );

  r.post(
    '/devices/:id/revoke',
    { schema: { params: idParamsSchema }, config: { access } },
    (request) =>
      inTenant(deps, request, async (trx, auth) => {
        const { id } = request.params;
        const now = deps.now();
        const before = await loadDevice(trx, id);
        if (before.revokedAt !== null) return before;
        await trx
          .updateTable('devices')
          .set({
            revoked_at: now,
            revoked_by: auth.userId,
            enrollment_code_hash: null,
            enrollment_expires_at: null,
          })
          .where('id', '=', id)
          .execute();
        await revokeSessions(trx, { deviceId: id }, 'device_revoked', now);
        const after = await loadDevice(trx, id);
        await audit(
          trx,
          actorOf(request),
          { action: 'device.revoke', entityType: 'device', entityId: id, before, after },
          now,
        );
        return after;
      }),
  );

  // Called by the device itself, before anyone has signed in on it.
  r.post(
    '/devices/enroll',
    {
      schema: { body: enrollDeviceSchema },
      preHandler: credentialThrottle,
      config: {
        access: 'public',
        rateLimit: {
          ...ENROLL_RATE_LIMIT,
          hook: 'preHandler',
          keyGenerator: (req) =>
            `enroll|${req.ip}|${String((req.body as { tenant?: unknown } | undefined)?.tenant)}`,
        },
      },
    },
    async (request) => {
      const invalid = new ApiError(400, 'device.invalid_code');
      const tenantId = await resolveTenant(deps.db, request.body.tenant);
      if (tenantId === null) throw invalid;
      const hash = sha256(normalizeEnrollmentCode(request.body.code));
      const credential = randomSecret();
      const now = deps.now();
      return withTenant(deps.db, tenantId, async (trx) => {
        const device = await trx
          .selectFrom('devices')
          .select(['id', 'enrollment_expires_at'])
          .where('enrollment_code_hash', '=', hash)
          .where('revoked_at', 'is', null)
          .where('enrolled_at', 'is', null)
          .executeTakeFirst();
        if (device?.enrollment_expires_at == null || device.enrollment_expires_at <= now) {
          throw invalid;
        }
        await trx
          .updateTable('devices')
          .set({
            credential_hash: sha256(credential),
            enrolled_at: now,
            last_seen_at: now,
            enrollment_code_hash: null,
            enrollment_expires_at: null,
          })
          .where('id', '=', device.id)
          .execute();
        await audit(
          trx,
          { tenantId, userId: null, deviceId: device.id, requestId: request.id },
          {
            action: 'device.enroll',
            entityType: 'device',
            entityId: device.id,
            after: { ip: request.ip },
          },
          now,
        );
        return { deviceId: device.id, credential };
      });
    },
  );
}
