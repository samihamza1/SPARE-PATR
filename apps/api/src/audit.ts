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
  await auditMany(trx, actor, [entry], now);
}

/** Rows per INSERT: well under PostgreSQL's limit of 65,535 parameters. */
const AUDIT_CHUNK = 1000;

/** Like audit(), for one action that changes many entities (one entry each). */
export async function auditMany(
  trx: Transaction<DB>,
  actor: AuditActor,
  entries: readonly AuditInput[],
  now: Date,
): Promise<void> {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  for (let i = 0; i < entries.length; i += AUDIT_CHUNK) {
    await trx
      .insertInto('audit_log')
      .values(
        entries.slice(i, i + AUDIT_CHUNK).map((entry) => ({
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
        })),
      )
      .execute();
  }
}
