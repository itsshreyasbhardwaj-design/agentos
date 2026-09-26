import { describe, expect, it } from 'vitest';
import { nextCronRun, nextRunAt, parseCron } from './cron.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseCron', () => {
  it('parses wildcards, lists, ranges and steps', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9-11 * * *').hours).toEqual([9, 10, 11]);
    expect(parseCron('0 0 1,15 * *').daysOfMonth).toEqual([1, 15]);
    expect(parseCron('0 0 * jan,dec *').months).toEqual([1, 12]);
    expect(parseCron('0 0 * * mon-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats 7 as Sunday', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
  });

  it('expands aliases', () => {
    expect(parseCron('@daily')).toMatchObject({ minutes: [0], hours: [0] });
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * *')).toThrow(/5 fields/);
    expect(() => parseCron('99 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 5-2 * * *')).toThrow(/inverted/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid step/);
  });
});

describe('nextCronRun', () => {
  const base = Date.parse('2026-03-10T08:30:00Z');

  it('finds the next matching minute', () => {
    expect(iso(nextCronRun('0 9 * * *', base))).toBe('2026-03-10T09:00:00.000Z');
    expect(iso(nextCronRun('*/15 * * * *', base))).toBe('2026-03-10T08:45:00.000Z');
  });

  it('is strictly after the given instant', () => {
    const exact = Date.parse('2026-03-10T09:00:00Z');
    expect(iso(nextCronRun('0 9 * * *', exact))).toBe('2026-03-11T09:00:00.000Z');
  });

  it('rolls over months and years', () => {
    expect(iso(nextCronRun('0 0 1 1 *', Date.parse('2026-06-01T00:00:00Z')))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // The 13th, or any Friday — whichever comes first.
    const from = Date.parse('2026-03-10T00:00:00Z'); // Tuesday
    expect(iso(nextCronRun('0 0 13 * fri', from))).toBe('2026-03-13T00:00:00.000Z');
  });

  it('respects a timezone', () => {
    // 09:00 in Asia/Kolkata (UTC+5:30) is 03:30 UTC.
    expect(iso(nextCronRun('0 9 * * *', base, 'Asia/Kolkata'))).toBe('2026-03-11T03:30:00.000Z');
  });

  it('returns null for a date that never occurs', () => {
    expect(nextCronRun('0 0 30 2 *', base)).toBeNull();
  });
});

describe('nextRunAt', () => {
  it('advances interval schedules', () => {
    expect(nextRunAt('interval', '60000', 1_000)).toBe(61_000);
    expect(() => nextRunAt('interval', '10', 0)).toThrow(/at least 1000 ms/);
  });

  it('fires a one-shot schedule once and then never again', () => {
    const at = '2026-05-01T00:00:00Z';
    expect(nextRunAt('at', at, Date.parse('2026-04-01T00:00:00Z'))).toBe(Date.parse(at));
    expect(nextRunAt('at', at, Date.parse('2026-06-01T00:00:00Z'))).toBeNull();
  });
});
