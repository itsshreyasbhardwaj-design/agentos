import { AgentOSError } from '@agentos/core';

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(raw: string, min: number, max: number, names: string[] = [], nameBase = 0): number[] {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new AgentOSError('invalid_request', `invalid step '${stepPart}' in cron field '${raw}'`);
    }

    let start: number;
    let end: number;
    const range = (rangePart ?? '').trim().toLowerCase();
    if (range === '*' || range === '') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      start = resolveName(a ?? '', names, min, max, raw, nameBase);
      end = resolveName(b ?? '', names, min, max, raw, nameBase);
    } else {
      start = resolveName(range, names, min, max, raw, nameBase);
      end = stepPart === undefined ? start : max;
    }

    if (start > end) throw new AgentOSError('invalid_request', `inverted range in cron field '${raw}'`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** `nameBase` is the numeric value of the first name: months start at 1 (jan), weekdays at 0 (sun). */
function resolveName(
  token: string,
  names: string[],
  min: number,
  max: number,
  field: string,
  nameBase = 0,
): number {
  const index = names.indexOf(token.toLowerCase());
  const value = index >= 0 ? index + nameBase : Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AgentOSError('invalid_request', `value '${token}' is out of range in cron field '${field}'`);
  }
  return value;
}

/**
 * Parse a standard five-field cron expression (minute hour day-of-month month
 * day-of-week), plus the common `@daily`-style aliases.
 *
 * Written rather than pulled in as a dependency so the scheduler's semantics —
 * especially the day-of-month/day-of-week OR rule — are explicit and tested.
 */
export function parseCron(expression: string): CronFields {
  const normalised = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim().replace(/\s+/g, ' ');
  const parts = normalised.split(' ');
  if (parts.length !== 5) {
    throw new AgentOSError('invalid_request', `cron expression must have 5 fields, got ${parts.length}: '${expression}'`);
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(month, 1, 12, MONTH_NAMES, 1),
    // Accept 7 as Sunday, as crontab does. Deduplicate afterwards: without it
    // `*` would yield eight entries and look like a restricted set, which
    // silently changes the day-of-month/day-of-week OR rule below.
    daysOfWeek: [...new Set(parseField(dow, 0, 7, DAY_NAMES).map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
  };
}

function offsetForZone(timestamp: number, timeZone: string): number {
  // Derive the zone offset by formatting the instant in that zone and reading
  // the wall-clock components back. Avoids shipping a timezone database.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) === 24 ? 0 : Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUtc - timestamp;
}

function matches(fields: CronFields, date: Date): boolean {
  const dom = fields.daysOfMonth;
  const dow = fields.daysOfWeek;
  const domRestricted = dom.length !== 31;
  const dowRestricted = dow.length !== 7;

  const dayMatches =
    domRestricted && dowRestricted
      ? // crontab semantics: when both are restricted, either one matching fires.
        dom.includes(date.getUTCDate()) || dow.includes(date.getUTCDay())
      : (!domRestricted || dom.includes(date.getUTCDate())) && (!dowRestricted || dow.includes(date.getUTCDay()));

  return (
    fields.minutes.includes(date.getUTCMinutes()) &&
    fields.hours.includes(date.getUTCHours()) &&
    fields.months.includes(date.getUTCMonth() + 1) &&
    dayMatches
  );
}

/**
 * Next firing strictly after `after`, in the given IANA timezone.
 * Returns null if nothing matches within four years (e.g. `0 0 30 2 *`).
 */
export function nextCronRun(expression: string, after: number, timeZone = 'UTC'): number | null {
  const fields = parseCron(expression);
  // Step minute by minute from the next whole minute.
  let cursor = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = after + 4 * 366 * 24 * 60 * 60 * 1_000;

  while (cursor <= limit) {
    const offset = timeZone === 'UTC' ? 0 : offsetForZone(cursor, timeZone);
    const local = new Date(cursor + offset);
    if (matches(fields, local)) return cursor;

    // Skip the rest of the hour when this hour can never match; over a
    // four-year search that is the difference between ~2M and ~35k iterations.
    cursor += fields.hours.includes(local.getUTCHours()) ? 60_000 : (60 - local.getUTCMinutes()) * 60_000;
  }
  return null;
}

export type ScheduleKindLike = 'cron' | 'interval' | 'at';

/** Next run for any schedule kind, or null when it will not fire again. */
export function nextRunAt(
  kind: ScheduleKindLike,
  expression: string,
  after: number,
  timeZone = 'UTC',
): number | null {
  if (kind === 'cron') return nextCronRun(expression, after, timeZone);
  if (kind === 'interval') {
    const ms = Number(expression);
    if (!Number.isFinite(ms) || ms < 1_000) {
      throw new AgentOSError('invalid_request', 'interval schedules must be at least 1000 ms');
    }
    return after + ms;
  }
  const at = Date.parse(expression);
  if (Number.isNaN(at)) throw new AgentOSError('invalid_request', `'${expression}' is not a valid ISO timestamp`);
  // A one-shot schedule that has already fired never fires again.
  return at > after ? at : null;
}
