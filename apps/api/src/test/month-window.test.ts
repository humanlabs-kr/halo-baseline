import { describe, expect, it } from 'vitest';
import { monthWindow } from '../routes/client/ledger';

/**
 * A month-to-date compared against a whole previous month is the easiest way to
 * make a ledger lie: on the 5th it would tell the user their spending collapsed.
 * These tests pin that both windows always cover the same number of days.
 */
describe('monthWindow', () => {
  it('clips a month in progress to the days elapsed, on both sides', () => {
    const window = monthWindow('2026-09', new Date('2026-09-20T12:00:00Z'));

    expect(window.throughDay).toBe(20);
    expect(window.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(window.previousKey).toBe('2026-08');
    expect(window.previousStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(window.previousEnd.toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });

  it('uses the whole month once it is over', () => {
    const window = monthWindow('2026-08', new Date('2026-09-20T12:00:00Z'));

    expect(window.throughDay).toBe(31);
    expect(window.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(window.previousEnd.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rolls back across a year boundary', () => {
    const window = monthWindow('2026-01', new Date('2026-01-10T00:00:00Z'));

    expect(window.previousKey).toBe('2025-12');
    expect(window.previousStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(window.previousEnd.toISOString()).toBe('2025-12-11T00:00:00.000Z');
  });

  it('stops the comparison window at the end of the shorter month', () => {
    // The comment on this assertion used to say the window "must not wander
    // past the end of it" and then asserted 2026-03-04, four days into the
    // month being reported. March's own spend was counted on both bars, and
    // the label read "1–31 Feb".
    const window = monthWindow('2026-03', new Date('2026-03-31T00:00:00Z'));

    expect(window.throughDay).toBe(31);
    expect(window.previousStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(window.previousEnd.toISOString()).toBe('2026-03-01T00:00:00.000Z');

    // And says so, so the screen can label a 28-day bar as 28 days rather
    // than claiming it covers the same span as the 31 beside it.
    expect(window.previousThroughDay).toBe(28);
  });

  it('leaves the span alone when the previous month is long enough', () => {
    const window = monthWindow('2026-01', new Date('2026-01-10T00:00:00Z'));

    expect(window.throughDay).toBe(10);
    expect(window.previousThroughDay).toBe(10);
  });

  it('never lets the comparison window reach the reported month', () => {
    // Every month boundary, both directions. The failure this guards is one
    // day of overlap, which is invisible in a total and wrong in a ledger.
    for (let month = 1; month <= 12; month += 1) {
      const key = `2026-${String(month).padStart(2, '0')}`;
      const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      const window = monthWindow(key, new Date(`${key}-${lastDay}T00:00:00Z`));

      expect(window.previousEnd.getTime()).toBeLessThanOrEqual(window.start.getTime());
      expect(window.previousStart.getTime()).toBeLessThan(window.previousEnd.getTime());
    }
  });

  it('defaults to the month the clock is in', () => {
    expect(monthWindow(undefined, new Date('2026-09-20T12:00:00Z')).key).toBe('2026-09');
  });
});
