import { z } from 'zod';
import { roundingModeSchema } from './money';

/**
 * Per-tenant settings stored in `tenants.settings` (ADR 0010).
 *
 * Two kinds of field:
 * - security/session defaults agreed with the product owner (have a default);
 * - business rules the BRIEF leaves to each tenant (rounding, negative stock): required,
 *   no default, chosen explicitly at provisioning.
 * Bounds are sanity limits, not business rules.
 */
export const tenantSettingsSchema = z.object({
  session: z
    .object({
      idleMinutes: z
        .int()
        .min(5)
        .max(24 * 60)
        .default(30),
      absoluteHours: z.int().min(1).max(24).default(12),
    })
    .prefault({}),
  security: z
    .object({
      maxFailedLogins: z.int().min(3).max(50).default(5),
      lockoutMinutes: z
        .int()
        .min(1)
        .max(24 * 60)
        .default(15),
    })
    .prefault({}),
  money: z.object({
    roundingMode: roundingModeSchema,
  }),
  inventory: z.object({
    allowNegativeStock: z.boolean(),
  }),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type TenantSettingsInput = z.input<typeof tenantSettingsSchema>;
