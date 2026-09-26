/** Glob matching for tool names and similar identifiers. Supports `*` only. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function anyGlobMatch(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}

/**
 * Host matching for network allowlists. `example.com` matches only that host;
 * `*.example.com` matches subdomains but NOT the apex, which keeps an allowlist
 * from being widened by accident.
 */
export function hostMatch(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = host.toLowerCase().trim();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export function anyHostMatch(patterns: readonly string[], host: string): boolean {
  return patterns.some((p) => hostMatch(p, host));
}
