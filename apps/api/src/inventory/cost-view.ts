import type { AuthContext } from '../auth/context';

/**
 * BRIEF: cashiers sell but never see cost or margin. Values of stock travel under a `cost`
 * key that is only filled for users with cost.view (ADR 0022).
 */
export function seesCost(auth: Pick<AuthContext, 'permissions'>): boolean {
  return auth.permissions.has('cost.view');
}

/** Drops `cost` from audit before/after snapshots for users without cost.view. */
export function withoutCost(snapshot: unknown): unknown {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  return Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== 'cost'));
}
