import { AgentOSError } from '@agentos/core';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface FetchGuardOptions {
  /** Returns true when the host is permitted by policy for this execution. */
  isHostAllowed(host: string): boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** Allow addresses in private ranges. Off by default; opt in for self-hosted. */
  allowPrivateAddresses?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real DNS lookup. */
  resolveHost?: (host: string) => Promise<string[]>;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] as number) << 24) | ((parts[1] as number) << 16) | ((parts[2] as number) << 8) | (parts[3] as number);
}

/** RFC1918, loopback, link-local (incl. cloud metadata), CGNAT, broadcast. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return true;
    const inRange = (cidr: string, bits: number) => {
      const base = ipv4ToInt(cidr);
      if (base === null) return false;
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (base & mask) >>> 0;
    };
    return (
      inRange('0.0.0.0', 8) ||
      inRange('10.0.0.0', 8) ||
      inRange('100.64.0.0', 10) ||
      inRange('127.0.0.0', 8) ||
      inRange('169.254.0.0', 16) ||
      inRange('172.16.0.0', 12) ||
      inRange('192.0.0.0', 24) ||
      inRange('192.168.0.0', 16) ||
      inRange('198.18.0.0', 15) ||
      inRange('224.0.0.0', 4) ||
      inRange('240.0.0.0', 4)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:169.254.169.254) must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/**
 * Network egress for tools.
 *
 * Every hop is checked twice: the hostname against the execution's policy
 * allow-list, and the resolved IP addresses against private ranges. Redirects
 * are followed manually so a 302 cannot walk an allowed host into the cloud
 * metadata endpoint, which is the classic SSRF escape.
 */
export function createGuardedFetch(options: FetchGuardOptions): typeof fetch {
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxResponseBytes ?? 5_000_000;
  const doFetch = options.fetchImpl ?? fetch;
  const resolveHost =
    options.resolveHost ??
    (async (host: string) => {
      const records = await lookup(host, { all: true });
      return records.map((r) => r.address);
    });

  const check = async (rawUrl: string): Promise<URL> => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AgentOSError('invalid_request', `invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AgentOSError('policy_denied', `protocol ${url.protocol} is not permitted`, {
        details: { url: url.toString() },
      });
    }
    if (url.username || url.password) {
      throw new AgentOSError('policy_denied', 'URLs with embedded credentials are not permitted');
    }
    if (!options.isHostAllowed(url.hostname)) {
      throw new AgentOSError('policy_denied', `host ${url.hostname} is not in the allowed domain list`, {
        details: { host: url.hostname },
      });
    }
    if (!options.allowPrivateAddresses) {
      const literal = isIP(url.hostname.replace(/^\[|\]$/g, ''));
      const addresses = literal ? [url.hostname.replace(/^\[|\]$/g, '')] : await resolveHost(url.hostname);
      if (addresses.length === 0) {
        throw new AgentOSError('provider_unavailable', `could not resolve ${url.hostname}`);
      }
      for (const address of addresses) {
        if (isPrivateAddress(address)) {
          throw new AgentOSError(
            'policy_denied',
            `host ${url.hostname} resolves to a private address and is blocked`,
            { details: { host: url.hostname, address } },
          );
        }
      }
    }
    return url;
  };

  return async function guardedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    let target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let redirects = 0;
    let method = init.method ?? 'GET';
    let body = init.body;

    for (;;) {
      const url = await check(target);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
      const onAbort = () => controller.abort();
      init.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      try {
        response = await doFetch(url, {
          ...init,
          method,
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new AgentOSError('timeout', `request to ${url.hostname} timed out`);
        }
        throw new AgentOSError('provider_unavailable', `request to ${url.hostname} failed`, { cause: error });
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onAbort);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        if (redirects >= maxRedirects) {
          throw new AgentOSError('policy_denied', `too many redirects (>${maxRedirects})`);
        }
        redirects += 1;
        target = new URL(location, url).toString();
        // A 303, or any redirect of a POST, continues as a GET without a body.
        if (response.status === 303 || (method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        throw new AgentOSError('invalid_request', `response of ${declared} bytes exceeds the ${maxBytes} byte cap`);
      }
      return response;
    }
  } as typeof fetch;
}
