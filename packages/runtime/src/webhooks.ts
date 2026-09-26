import {
  AgentOSError,
  hmacSha256,
  newId,
  safeEqual,
  sha256,
  TokenBucketLimiter,
  type JsonValue,
  type WebhookEndpointRecord,
} from '@agentos/core';
import type { RuntimeContext } from './context.js';
import { ExecutionService } from './execution-service.js';

export interface IncomingWebhook {
  endpointId: string;
  headers: Record<string, string>;
  /** Raw body bytes as received. Signatures are computed over this, not a re-serialised object. */
  rawBody: string;
  receivedAt?: number;
}

export interface WebhookResult {
  accepted: boolean;
  executionId: string | null;
  reason: string | null;
  duplicate: boolean;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Verify a provider signature.
 *
 * Every branch compares in constant time and binds the signature to a
 * timestamp where the provider supplies one, so a captured-and-replayed
 * request fails on age even before the dedupe store sees it.
 */
export function verifySignature(
  endpoint: WebhookEndpointRecord,
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
  now: number,
): { valid: boolean; reason?: string; dedupeKey: string } {
  const fallbackKey = sha256(rawBody);

  if (endpoint.provider === 'github') {
    const signature = header(headers, 'x-hub-signature-256');
    const deliveryId = header(headers, 'x-github-delivery');
    if (!signature) return { valid: false, reason: 'missing x-hub-signature-256', dedupeKey: deliveryId ?? fallbackKey };
    const expected = `sha256=${hmacSha256(secret, rawBody)}`;
    return {
      valid: safeEqual(signature, expected),
      reason: safeEqual(signature, expected) ? undefined : 'signature mismatch',
      dedupeKey: deliveryId ?? fallbackKey,
    };
  }

  if (endpoint.provider === 'stripe') {
    const raw = header(headers, 'stripe-signature');
    if (!raw) return { valid: false, reason: 'missing stripe-signature', dedupeKey: fallbackKey };
    const parts = Object.fromEntries(
      raw.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k?.trim() ?? '', v?.trim() ?? ''];
      }),
    );
    const timestamp = Number(parts['t']);
    const provided = parts['v1'];
    if (!provided || !Number.isFinite(timestamp)) {
      return { valid: false, reason: 'malformed stripe-signature', dedupeKey: fallbackKey };
    }
    const ageSeconds = Math.abs(now / 1_000 - timestamp);
    if (ageSeconds > endpoint.toleranceSeconds) {
      return { valid: false, reason: `timestamp is ${Math.round(ageSeconds)}s old`, dedupeKey: fallbackKey };
    }
    const expected = hmacSha256(secret, `${timestamp}.${rawBody}`);
    return {
      valid: safeEqual(provided, expected),
      reason: safeEqual(provided, expected) ? undefined : 'signature mismatch',
      dedupeKey: `${timestamp}:${fallbackKey}`,
    };
  }

  // Custom: HMAC over `${timestamp}.${body}` with an explicit timestamp header.
  const signature = header(headers, 'x-agentos-signature');
  const timestampHeader = header(headers, 'x-agentos-timestamp');
  if (!signature || !timestampHeader) {
    return { valid: false, reason: 'missing x-agentos-signature or x-agentos-timestamp', dedupeKey: fallbackKey };
  }
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'malformed timestamp', dedupeKey: fallbackKey };
  const ageSeconds = Math.abs(now / 1_000 - timestamp);
  if (ageSeconds > endpoint.toleranceSeconds) {
    return { valid: false, reason: `timestamp is ${Math.round(ageSeconds)}s old`, dedupeKey: fallbackKey };
  }
  const expected = hmacSha256(secret, `${timestamp}.${rawBody}`);
  return {
    valid: safeEqual(signature, expected),
    reason: safeEqual(signature, expected) ? undefined : 'signature mismatch',
    dedupeKey: header(headers, 'x-agentos-event-id') ?? `${timestamp}:${fallbackKey}`,
  };
}

/** Signature helper for clients and tests. */
export function signCustomWebhook(secret: string, rawBody: string, timestampSeconds: number): Record<string, string> {
  return {
    'x-agentos-timestamp': String(timestampSeconds),
    'x-agentos-signature': hmacSha256(secret, `${timestampSeconds}.${rawBody}`),
  };
}

export class WebhookService {
  private readonly executions: ExecutionService;
  private readonly limiter: TokenBucketLimiter;

  constructor(private readonly ctx: RuntimeContext) {
    this.executions = new ExecutionService(ctx);
    this.limiter = new TokenBucketLimiter({ now: () => ctx.clock.now() });
  }

  async handle(incoming: IncomingWebhook): Promise<WebhookResult> {
    const now = incoming.receivedAt ?? this.ctx.clock.now();

    // Endpoint id is a public URL component, so nothing here may depend on it
    // being secret — authentication is the signature alone.
    const endpoint = await this.findEndpoint(incoming.endpointId);
    if (!endpoint) return { accepted: false, executionId: null, reason: 'unknown endpoint', duplicate: false };
    if (!endpoint.enabled) {
      return this.reject(endpoint, incoming, now, 'endpoint is disabled', null);
    }

    const rate = this.limiter.check(`webhook:${endpoint.id}`, {
      limit: endpoint.rateLimitPerMinute,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      return this.reject(endpoint, incoming, now, 'rate limit exceeded', null);
    }

    let secret: string;
    try {
      secret = await this.ctx.secrets.resolve(endpoint.orgId, endpoint.signingSecretName);
    } catch {
      return this.reject(endpoint, incoming, now, 'signing secret is not configured', null);
    }

    const verification = verifySignature(endpoint, incoming.headers, incoming.rawBody, secret, now);
    if (!verification.valid) {
      return this.reject(endpoint, incoming, now, verification.reason ?? 'invalid signature', verification.dedupeKey);
    }

    // Replay protection: the unique (endpoint, dedupeKey) index decides.
    const delivery = await this.ctx.store.webhooks.recordDelivery({
      id: newId('webhook'),
      orgId: endpoint.orgId,
      endpointId: endpoint.id,
      dedupeKey: verification.dedupeKey,
      receivedAt: now,
      accepted: true,
      rejectionReason: null,
      executionId: null,
    });
    if (!delivery) {
      return { accepted: false, executionId: null, reason: 'duplicate delivery', duplicate: true };
    }

    let payload: JsonValue;
    try {
      payload = JSON.parse(incoming.rawBody) as JsonValue;
    } catch {
      payload = incoming.rawBody;
    }

    const execution = await this.executions.run(
      { userId: endpoint.createdBy, orgId: endpoint.orgId, role: 'developer' },
      {
        agentRef: endpoint.agentId,
        input: { provider: endpoint.provider, event: header(incoming.headers, 'x-github-event') ?? null, payload },
        trigger: { type: 'webhook', sourceId: endpoint.id, actor: endpoint.provider },
        idempotencyKey: `webhook:${endpoint.id}:${verification.dedupeKey}`,
        labels: { webhook: endpoint.name },
      },
    );

    return { accepted: true, executionId: execution.id, reason: null, duplicate: false };
  }

  private async findEndpoint(endpointId: string): Promise<WebhookEndpointRecord | null> {
    for (const org of await this.ctx.store.orgs.list()) {
      const endpoint = await this.ctx.store.webhooks.getEndpoint(org.id, endpointId);
      if (endpoint) return endpoint;
    }
    return null;
  }

  private async reject(
    endpoint: WebhookEndpointRecord,
    incoming: IncomingWebhook,
    now: number,
    reason: string,
    dedupeKey: string | null,
  ): Promise<WebhookResult> {
    await this.ctx.store.webhooks.recordDelivery({
      id: newId('webhook'),
      orgId: endpoint.orgId,
      endpointId: endpoint.id,
      dedupeKey: dedupeKey ?? `rejected:${sha256(incoming.rawBody)}:${now}`,
      receivedAt: now,
      accepted: false,
      rejectionReason: reason,
      executionId: null,
    });
    this.ctx.logger.warn('webhook rejected', { endpointId: endpoint.id, reason });
    return { accepted: false, executionId: null, reason, duplicate: false };
  }
}

export function webhookError(reason: string): AgentOSError {
  return new AgentOSError('forbidden', `webhook rejected: ${reason}`);
}
