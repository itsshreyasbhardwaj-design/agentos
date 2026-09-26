import { AgentOSClient } from '@agentos/sdk';

/**
 * Server-side API client.
 *
 * The key lives only in the server process: this module is never imported from
 * a client component, and every mutation goes through a server action rather
 * than a browser fetch, so the dashboard's credential is never shipped to a
 * browser.
 */
export function api(): AgentOSClient {
  const baseUrl = process.env.AGENTOS_URL ?? 'http://127.0.0.1:8787';
  const apiKey = process.env.AGENTOS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AGENTOS_API_KEY is not set. Start the API with AGENTOS_SEED_DEMO=true, then export the key it prints.',
    );
  }
  return new AgentOSClient({ baseUrl, apiKey, timeoutMs: 15_000 });
}

export interface LoadError {
  message: string;
  hint?: string;
}

/**
 * Run a load and return either the data or a displayable error.
 *
 * The dashboard shows what the control plane actually returned. When the API is
 * unreachable it says so — it never falls back to sample numbers, because a
 * plausible-looking dashboard built from nothing is worse than an empty one.
 */
export async function load<T>(fn: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: LoadError }> {
  try {
    return { data: await fn(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      data: null,
      error: {
        message,
        hint: message.includes('AGENTOS_API_KEY')
          ? undefined
          : `Could not reach the AgentOS API at ${process.env.AGENTOS_URL ?? 'http://127.0.0.1:8787'}.`,
      },
    };
  }
}
