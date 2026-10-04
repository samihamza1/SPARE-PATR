import { assertCurrencySpec } from './currency.js';
import type { CurrencyCode, CurrencySpec } from './currency.js';
import { D, fromDFixed, parseDecimal, toD } from './decimal.js';
import type { DecimalString } from './decimal.js';

/** An amount in one currency, always at that currency's minor-unit scale. */
export interface Money {
  readonly amount: DecimalString;
  readonly currency: CurrencyCode;
}

/**
 * Build a Money value. Throws if the amount has more decimals than the currency
 * allows: rounding must be an explicit, visible step (see round()).
 */
export function money(amount: string, spec: CurrencySpec): Money {
  assertCurrencySpec(spec);
  const d = toD(parseDecimal(amount));
  if (d.decimalPlaces() > spec.minorUnits) {
    throw new RangeError(
      `Amount ${amount} has more than ${String(spec.minorUnits)} decimals for ${spec.code}; round it explicitly`,
    );
  }
  return { amount: fromDFixed(d, spec.minorUnits, 'DOWN'), currency: spec.code };
}

function assertSameCurrency(a: Money, b: Money, spec: CurrencySpec): void {
  if (a.currency !== spec.code || b.currency !== spec.code) {
    throw new RangeError(`Currency mismatch: ${a.currency} / ${b.currency} with spec ${spec.code}`);
  }
}

export function addMoney(a: Money, b: Money, spec: CurrencySpec): Money {
  assertSameCurrency(a, b, spec);
  return money(toD(a.amount).plus(toD(b.amount)).toString(), spec);
}

export function subMoney(a: Money, b: Money, spec: CurrencySpec): Money {
  assertSameCurrency(a, b, spec);
  return money(toD(a.amount).minus(toD(b.amount)).toString(), spec);
}

/**
 * Split `total` proportionally to `ratios` using the largest-remainder method.
 * Parts sum exactly to the total; each part is within one minor unit of its ideal
 * share; ties go to the earlier index (deterministic).
 */
export function allocate(
  total: Money,
  ratios: readonly DecimalString[],
  spec: CurrencySpec,
): Money[] {
  assertCurrencySpec(spec);
  if (total.currency !== spec.code) throw new RangeError('Currency mismatch in allocate');
  if (ratios.length === 0) throw new RangeError('allocate needs at least one ratio');
  const rs = ratios.map(toD);
  if (rs.some((r) => r.isNegative() && !r.isZero())) {
    throw new RangeError('allocate ratios must be non-negative');
  }
  const ratioSum = rs.reduce((acc, r) => acc.plus(r), new D(0));
  if (ratioSum.isZero()) throw new RangeError('allocate ratios must not all be zero');

  const unit = new D(10).pow(spec.minorUnits);
  const totalUnits = toD(total.amount).times(unit);
  const negative = totalUnits.isNegative();
  const absUnits = totalUnits.abs();

  const ideals = rs.map((r) => absUnits.times(r).dividedBy(ratioSum));
  const floors = ideals.map((x) => x.floor());
  let remainder = absUnits.minus(floors.reduce((acc, f) => acc.plus(f), new D(0)));

  const order = ideals
    .map((x, i) => ({ i, frac: x.minus(floors[i] ?? 0) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);

  const parts = [...floors];
  for (const { i } of order) {
    if (!remainder.isPositive() || remainder.isZero()) break;
    parts[i] = (parts[i] ?? new D(0)).plus(1);
    remainder = remainder.minus(1);
  }

  return parts.map((p) => {
    const signed = negative ? p.negated() : p;
    return {
      amount: fromDFixed(signed.dividedBy(unit), spec.minorUnits, 'DOWN'),
      currency: spec.code,
    };
  });
}
