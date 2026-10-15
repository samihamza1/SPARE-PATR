import { z } from 'zod';

/**
 * Permission codes are defined in code and stored on roles (`roles.permissions`).
 * Platform permissions only; sales, inventory and accounting add theirs with their modules.
 * Labels live in the apps' i18n files under `permissions.<code>`.
 */
export const PERMISSIONS = [
  'users.manage',
  'roles.manage',
  'settings.manage',
  'devices.manage',
  'sessions.manage',
  'audit.read',
  // BRIEF: cashiers sell but cannot see cost or margin.
  'cost.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const permissionSchema = z.enum(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Unknown codes (e.g. from a newer client or a removed permission) are dropped, never trusted. */
export function toPermissions(values: readonly string[]): Permission[] {
  return [...new Set(values.filter(isPermission))].sort();
}

export interface RoleTemplate {
  code: string;
  /** Stored as the role name; the UI shows the translation of `roles.system.<code>`. */
  name: string;
  permissions: readonly Permission[];
}

/**
 * System roles copied into every new tenant (BRIEF "Roles"). Tenants can edit their copies.
 * Initial platform permission sets as agreed in the Sprint 2 plan.
 */
export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { code: 'owner', name: 'Owner', permissions: PERMISSIONS },
  {
    code: 'supervisor',
    name: 'Supervisor',
    permissions: ['audit.read', 'sessions.manage', 'cost.view'],
  },
  { code: 'accountant', name: 'Accountant', permissions: ['audit.read', 'cost.view'] },
  { code: 'cashier', name: 'Cashier', permissions: [] },
];
