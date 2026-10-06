import { z } from 'zod';
import { roundingModeSchema } from './money';

/** Business rules each module reads on its own (ADR 0022), so one module's gap never blocks another. */
export const moneySettingsSchema = z.object({
  roundingMode: roundingModeSchema,
});
export const inventorySettingsSchema = z.object({
  allowNegativeStock: z.boolean(),
});

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
  money: moneySettingsSchema,
  inventory: inventorySettingsSchema,
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type TenantSettingsInput = z.input<typeof tenantSettingsSchema>;
