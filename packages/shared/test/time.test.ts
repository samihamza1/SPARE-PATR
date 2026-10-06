import { describe, expect, it } from 'vitest';
import { businessDate } from '../src/time';

describe('businessDate', () => {
  it('gives the calendar date in the tenant time zone', () => {
    const instant = new Date('2026-10-06T22:30:00Z');
    expect(businessDate(instant, 'UTC')).toBe('2026-10-06');
    // UTC+2 and UTC+4 are already on the next day; UTC-5 is not.
    expect(businessDate(instant, 'Africa/Juba')).toBe('2026-10-07');
    expect(businessDate(instant, 'Asia/Dubai')).toBe('2026-10-07');
    expect(businessDate(instant, 'America/New_York')).toBe('2026-10-06');
  });

  it('rejects unknown time zones', () => {
    expect(() => businessDate(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});
