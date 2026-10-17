import type { AuthContext } from '../auth/context';
import { forbidden } from '../errors';

/**
 * BRIEF: cashiers sell but never see cost or margin. Values of stock travel under a `cost`
 * key that is only filled for users with cost.view (ADR 0022).
 */
export function seesCost(auth: Pick<AuthContext, 'permissions'>): boolean {
  return auth.permissions.has('cost.view');
}

/**
 * Screens that show or enter values (opening stock, purchasing) need cost.view as well as
 * their own permission; a route's access names one code only, so handlers call this.
 */
export function requireCostView(auth: Pick<AuthContext, 'permissions'>): void {
  if (!seesCost(auth)) throw forbidden();
}

/** Drops `cost` from audit before/after snapshots for users without cost.view. */
export function withoutCost(snapshot: unknown): unknown {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  return Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== 'cost'));
}
