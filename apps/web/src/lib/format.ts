export function usd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return `$${dollars.toFixed(5)}`;
  if (dollars < 1) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function count(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return '—';
  const delta = now - timestamp;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const units: Array<[number, string]> = [
    [1_000, 'second'],
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
  ];
  let value = Math.round(abs / 1_000);
  let unit = 'second';
  for (const [ms, name] of units) {
    if (abs >= ms) {
      value = Math.floor(abs / ms);
      unit = name;
    }
  }
  if (abs < 1_000) return 'just now';
  const plural = value === 1 ? '' : 's';
  return future ? `in ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
}

export function absoluteTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function truncate(value: string, max = 64): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** "1 approval", "2 approvals" — small, but it shows up in screenshots. */
export function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}
