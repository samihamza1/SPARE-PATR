import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  passwordSchema,
  tenantSettingsSchema,
  toPermissions,
} from '../../src';

describe('permissions', () => {
  it('drops unknown codes and de-duplicates', () => {
    expect(toPermissions(['audit.read', 'bogus', 'audit.read', 'cost.view'])).toEqual([
      'audit.read',
      'cost.view',
    ]);
  });

  it('system role templates use known permissions; the owner has all, the cashier no cost view', () => {
    const byCode = new Map(SYSTEM_ROLE_TEMPLATES.map((r) => [r.code, r]));
    expect([...byCode.keys()].sort()).toEqual(['accountant', 'cashier', 'owner', 'supervisor']);
    expect([...(byCode.get('owner')?.permissions ?? [])].sort()).toEqual([...PERMISSIONS].sort());
    expect(byCode.get('cashier')?.permissions).not.toContain('cost.view');
    for (const r of SYSTEM_ROLE_TEMPLATES) {
      expect(toPermissions(r.permissions)).toEqual([...r.permissions].sort());
    }
  });
});

describe('password policy', () => {
  it.each([
    ['short', 'password.too_short'],
    ['x'.repeat(129), 'password.too_long'],
    ['Password123', 'password.too_common'],
  ])('rejects %j', (password, message) => {
    const result = passwordSchema.safeParse(password);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('accepts long passphrases without composition rules', () => {
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });
});

describe('tenant settings', () => {
  it('requires the business rules the BRIEF leaves to each tenant', () => {
    const result = tenantSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path.join('.')).sort();
    expect(paths).toEqual(['inventory', 'money']);
  });

  it('fills security defaults agreed in the plan', () => {
    const parsed = tenantSettingsSchema.parse({
      money: { roundingMode: 'HALF_EVEN' },
      inventory: { allowNegativeStock: false },
    });
    expect(parsed.session).toEqual({ idleMinutes: 30, absoluteHours: 12 });
    expect(parsed.security).toEqual({ maxFailedLogins: 5, lockoutMinutes: 15 });
  });

  it('rejects out-of-range values and unknown rounding modes', () => {
    const base = { money: { roundingMode: 'HALF_EVEN' }, inventory: { allowNegativeStock: true } };
    expect(tenantSettingsSchema.safeParse({ ...base, session: { idleMinutes: 0 } }).success).toBe(
      false,
    );
    expect(
      tenantSettingsSchema.safeParse({ ...base, money: { roundingMode: 'NEAREST' } }).success,
    ).toBe(false);
  });
});
