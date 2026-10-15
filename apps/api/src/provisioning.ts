import type { DB } from '@autoparts/db';
import { withTenant } from '@autoparts/db';
import {
  SYSTEM_ROLE_TEMPLATES,
  currencyCodeSchema,
  decimalStringSchema,
  newId,
  passwordSchema,
  tenantSettingsSchema,
} from '@autoparts/shared';
import type { TenantSettingsInput } from '@autoparts/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { audit } from './audit';
import { hashPassword } from './security/password';

/**
 * Everything a new tenant needs. Nothing money, tax or locale related has a default:
 * the operator supplies every value (CLAUDE.md).
 */
export const provisionInputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(63),
  name: z.string().trim().min(1).max(200),
  timezone: z.string().min(1),
  defaultLocale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  functionalCurrency: z.object({
    code: currencyCodeSchema,
    minorUnits: z.int().min(0).max(4),
    cashIncrement: decimalStringSchema.nullish(),
  }),
  settings: tenantSettingsSchema,
  /** The default shop, where devices sell from (ADR 0018); more are added later. */
  locationName: z.string().trim().min(1).max(100),
  owner: z.object({
    username: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(200),
    password: passwordSchema,
  }),
});

export type ProvisionInput = Omit<z.input<typeof provisionInputSchema>, 'settings'> & {
  settings: TenantSettingsInput;
};

export interface ProvisionResult {
  tenantId: string;
  ownerUserId: string;
}

/**
 * Creates a tenant with its functional currency, the system roles from the BRIEF and an
 * owner user. Runs as autoparts_owner (the app role cannot create tenants), in one
 * transaction with the new tenant as RLS context.
 */
export async function provisionTenant(
  ownerDb: Kysely<DB>,
  raw: ProvisionInput,
  now = new Date(),
): Promise<ProvisionResult> {
  const input = provisionInputSchema.parse(raw);
  const tenantId = newId();
  const ownerUserId = newId();
  const passwordHash = await hashPassword(input.owner.password);

  await withTenant(ownerDb, tenantId, async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: tenantId,
        slug: input.slug,
        name: input.name,
        functional_currency: input.functionalCurrency.code,
        timezone: input.timezone,
        default_locale: input.defaultLocale,
        settings: JSON.stringify(input.settings),
      })
      .execute();
    await trx
      .insertInto('tenant_currencies')
      .values({
        id: newId(),
        tenant_id: tenantId,
        code: input.functionalCurrency.code,
        minor_units: input.functionalCurrency.minorUnits,
        cash_increment: input.functionalCurrency.cashIncrement ?? null,
      })
      .execute();

    await trx
      .insertInto('locations')
      .values({
        id: newId(),
        tenant_id: tenantId,
        name: input.locationName,
        kind: 'shop',
        is_default: true,
      })
      .execute();

    const roleIds = new Map<string, string>();
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const id = newId();
      roleIds.set(template.code, id);
      await trx
        .insertInto('roles')
        .values({
          id,
          tenant_id: tenantId,
          code: template.code,
          name: template.name,
          permissions: [...template.permissions],
          is_system: true,
        })
        .execute();
    }

    await trx
      .insertInto('users')
      .values({
        id: ownerUserId,
        tenant_id: tenantId,
        username: input.owner.username,
        display_name: input.owner.displayName,
        password_hash: passwordHash,
        password_changed_at: now,
      })
      .execute();
    await trx
      .insertInto('user_roles')
      .values({
        id: newId(),
        tenant_id: tenantId,
        user_id: ownerUserId,
        role_id: roleIds.get('owner') ?? '',
        granted_at: now,
      })
      .execute();

    await audit(
      trx,
      { tenantId, userId: null },
      {
        action: 'tenant.provision',
        entityType: 'tenant',
        entityId: tenantId,
        after: {
          slug: input.slug,
          name: input.name,
          timezone: input.timezone,
          defaultLocale: input.defaultLocale,
          functionalCurrency: input.functionalCurrency,
          settings: input.settings,
          owner: { id: ownerUserId, username: input.owner.username },
        },
      },
      now,
    );
  });

  return { tenantId, ownerUserId };
}
