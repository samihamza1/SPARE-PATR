import { assertScale } from './decimal.js';
import type { DecimalString } from './decimal.js';

/** ISO 4217 alphabetic code. Which currencies a tenant uses is configuration, never code. */
export type CurrencyCode = string;

const CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Everything the money utilities need to know about a currency. Supplied by the
 * caller (per-tenant configuration); this package deliberately ships no currency table.
 */
export interface CurrencySpec {
  readonly code: CurrencyCode;
  /** Decimal places of the minor unit (e.g. 0, 2, 3). */
  readonly minorUnits: number;
  /** Smallest cash denomination, if cash rounding applies. */
  readonly cashIncrement?: DecimalString;
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

export function assertCurrencyCode(value: unknown): asserts value is CurrencyCode {
  if (!isCurrencyCode(value))
    throw new RangeError(`Invalid currency code: ${JSON.stringify(value)}`);
}

export function assertCurrencySpec(spec: CurrencySpec): void {
  assertCurrencyCode(spec.code);
  assertScale(spec.minorUnits, 'minorUnits');
}
