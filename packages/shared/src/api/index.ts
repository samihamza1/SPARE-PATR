import { z } from 'zod';
import { passwordSchema } from '../auth/password';
import { permissionSchema } from '../auth/permissions';
import { uuidSchema, uuidV7Schema } from '../ids';
import { currencyCodeSchema, decimalStringSchema } from '../money';
import { tenantSettingsSchema } from '../settings';

/**
 * HTTP contract shared by the API and the web apps. Field names are camelCase on the wire.
 * Error responses carry a stable code that the UI translates (invariant 8).
 */

export const ERROR_CODES = [
  // Also a temporarily locked account, whatever the password (ADR 0017).
  'auth.invalid_credentials',
  'auth.unauthenticated',
  'auth.forbidden',
  'auth.bad_origin',
  'auth.wrong_password',
  // Granting or defining permissions the actor lacks, or managing a user who has them.
  'auth.exceeds_own_permissions',
  'request.invalid',
  'request.rate_limited',
  'resource.not_found',
  'resource.conflict',
  // Would leave the tenant with no active user able to manage users and roles.
  'users.last_admin',
  'device.invalid_code',
  // Catalog import (ADR 0016).
  'import.unreadable_file',
  'import.sheet_not_found',
  'import.too_many_rows',
  // Past the reading limits (inflated size, memory or time).
  'import.file_too_large',
  'import.already_applied',
  'import.not_editable',
  // Inventory (ADRs 0018-0021).
  'settings.incomplete',
  'location.archived',
  'location.has_devices',
  'location.not_a_shop',
  'fx.rate_missing',
  'fx.future_date',
  'stock.insufficient',
  'stock.concurrent_change',
  'stock.has_stock',
  'stock.cost_required',
  'stock.review_unresolved',
  'idempotency.conflict',
  'server.error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    /** Field-level validation issues (path + message key), for request.invalid. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(63);
const usernameSchema = z.string().trim().min(1).max(100);
const displayNameSchema = z.string().trim().min(1).max(200);
const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const timestampSchema = z.iso.datetime({ offset: true });

// --- auth -------------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  tenant: slugSchema,
  username: usernameSchema,
  // Not validated against the policy on login: old passwords must keep working.
  password: z.string().min(1).max(1024),
});

export const meResponseSchema = z.object({
  user: z.object({
    id: uuidSchema,
    username: z.string(),
    displayName: z.string(),
    locale: z.string().nullable(),
  }),
  tenant: z.object({
    id: uuidSchema,
    slug: z.string(),
    name: z.string(),
    defaultLocale: z.string(),
    functionalCurrency: currencyCodeSchema,
  }),
  permissions: z.array(permissionSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

// --- users ------------------------------------------------------------------------------

export const userSchema = z.object({
  id: uuidSchema,
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  locale: z.string().nullable(),
  archivedAt: timestampSchema.nullable(),
  lastLoginAt: timestampSchema.nullable(),
  roleIds: z.array(uuidSchema),
});
export type User = z.infer<typeof userSchema>;

export const createUserSchema = z.object({
  id: uuidV7Schema,
  username: usernameSchema,
  displayName: displayNameSchema,
  email: z.email().nullish(),
  locale: localeSchema.nullish(),
  password: passwordSchema,
});

export const updateUserSchema = z
  .object({
    displayName: displayNameSchema,
    email: z.email().nullable(),
    locale: localeSchema.nullable(),
  })
  .partial();

export const resetPasswordSchema = z.object({ password: passwordSchema });

export const grantRoleSchema = z.object({ roleId: uuidSchema });

// --- roles ------------------------------------------------------------------------------

export const roleSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(permissionSchema),
});
export type Role = z.infer<typeof roleSchema>;

export const createRoleSchema = z.object({
  id: uuidV7Schema,
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(50),
  name: displayNameSchema,
  permissions: z.array(permissionSchema),
});

export const updateRoleSchema = z
  .object({ name: displayNameSchema, permissions: z.array(permissionSchema) })
  .partial();

// --- settings and currencies ------------------------------------------------------------

export const settingsResponseSchema = z.object({
  name: z.string(),
  defaultLocale: z.string(),
  timezone: z.string(),
  functionalCurrency: currencyCodeSchema,
  /** null when stored settings are incomplete (tenant must finish setup). */
  settings: tenantSettingsSchema.nullable(),
});

export const updateSettingsSchema = z
  .object({
    name: displayNameSchema,
    defaultLocale: localeSchema,
    settings: tenantSettingsSchema,
  })
  .partial();

export const currencySchema = z.object({
  id: uuidSchema,
  code: currencyCodeSchema,
  minorUnits: z.int(),
  cashIncrement: decimalStringSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.int(),
  isFunctional: z.boolean(),
});
export type Currency = z.infer<typeof currencySchema>;

export const createCurrencySchema = z.object({
  id: uuidV7Schema,
  code: currencyCodeSchema,
  minorUnits: z.int().min(0).max(4),
  cashIncrement: decimalStringSchema.nullish(),
  sortOrder: z.int().optional(),
});

export const updateCurrencySchema = z
  .object({
    cashIncrement: decimalStringSchema.nullable(),
    isActive: z.boolean(),
    sortOrder: z.int(),
  })
  .partial();

// --- devices ----------------------------------------------------------------------------

export const deviceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  /** The shop it sells from (ADR 0018). */
  locationId: uuidSchema.nullable(),
  enrolledAt: timestampSchema.nullable(),
  enrollmentExpiresAt: timestampSchema.nullable(),
  lastSeenAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

export const createDeviceSchema = z.object({
  id: uuidV7Schema,
  name: z.string().trim().min(1).max(100),
  /** Defaults to the tenant's default shop. */
  locationId: uuidSchema.optional(),
});

export const createDeviceResponseSchema = z.object({
  device: deviceSchema,
  /** Shown once to the admin, typed on the device. */
  enrollmentCode: z.string(),
});

export const enrollDeviceSchema = z.object({
  tenant: slugSchema,
  code: z.string().trim().toUpperCase().min(1).max(64),
});

export const enrollDeviceResponseSchema = z.object({
  deviceId: uuidSchema,
  /** Stored by the device; shown nowhere else. */
  credential: z.string(),
});

// --- sessions and audit -----------------------------------------------------------------

export const sessionSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});

export const auditEntrySchema = z.object({
  id: uuidSchema,
  occurredAt: timestampSchema,
  actorUserId: uuidSchema.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: uuidSchema.nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  /** Keyset pagination: entries strictly older than this id (UUID v7 is time-ordered). */
  before: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParamsSchema = z.object({ id: uuidSchema });
