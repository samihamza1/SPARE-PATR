import type { DB } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type { Transaction } from 'kysely';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export interface AuditActor {
  tenantId: string;
  userId: string | null;
  deviceId?: string | null;
  requestId?: string;
}

/** Appends to audit_log in the caller's transaction, so the entry commits with the change. */
export async function audit(
  trx: Transaction<DB>,
  actor: AuditActor,
  entry: AuditInput,
  now: Date,
): Promise<void> {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  await trx
    .insertInto('audit_log')
    .values({
      id: newId(),
      tenant_id: actor.tenantId,
      occurred_at: now,
      actor_user_id: actor.userId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      before: json(entry.before),
      after: json(entry.after),
      reason: entry.reason ?? null,
      device_id: actor.deviceId ?? null,
      request_id: actor.requestId ?? null,
    })
    .execute();
}
