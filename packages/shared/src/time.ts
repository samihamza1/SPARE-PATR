/**
 * Invariant 6: instants are stored in UTC; business days follow the tenant's time zone.
 * Returns the calendar date (YYYY-MM-DD) of `instant` in `timeZone`.
 */
export function businessDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
