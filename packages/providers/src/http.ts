import { AgentOSError, type JsonValue } from '@agentos/core';

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Map transport and HTTP failures onto the shared error vocabulary. */
export async function httpJson<T = JsonValue>(url: string, options: HttpJsonOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch(url, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const code =
        response.status === 429
          ? 'rate_limited'
          : response.status >= 500
            ? 'provider_unavailable'
            : 'provider_error';
      throw new AgentOSError(code, `HTTP ${response.status} from ${new URL(url).host}`, {
        details: { status: response.status, body: text.slice(0, 2_000) },
        retryable: code !== 'provider_error',
      });
    }
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (AgentOSError.is(error)) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AgentOSError('timeout', `request to ${new URL(url).host} timed out after ${timeoutMs}ms`);
    }
    throw new AgentOSError('provider_unavailable', `request to ${new URL(url).host} failed`, { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}
