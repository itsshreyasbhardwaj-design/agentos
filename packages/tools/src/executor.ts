import {
  AgentOSError,
  applyDefaults,
  describeViolations,
  isJsonObject,
  nullLogger,
  Redactor,
  systemClock,
  TokenBucketLimiter,
  validateSchema,
  type Clock,
  type JsonObject,
  type JsonValue,
  type Logger,
  type SecretResolver,
  type ToolCall,
} from '@agentos/core';
import { createGuardedFetch } from './guarded-fetch.js';
import { scanForInjection } from './injection.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolDefinition, ToolResult, ToolWarning } from './types.js';

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  limiter?: TokenBucketLimiter;
  clock?: Clock;
  logger?: Logger;
  /** Outputs longer than this are truncated before entering the prompt. */
  maxOutputBytes?: number;
  /** Fail the call on output-schema violations instead of warning. */
  strictOutputSchema?: boolean;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  allowPrivateAddresses?: boolean;
}

export interface ExecuteOptions {
  orgId: string;
  agentId: string;
  executionId: string;
  secrets: SecretResolver;
  redactor?: Redactor;
  signal?: AbortSignal;
  /** Policy-backed host check. Required: there is no unrestricted network path. */
  isHostAllowed(host: string): boolean;
  /** Overrides the definition's timeout, e.g. from remaining execution budget. */
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Runs a single tool call under the runtime's control.
 *
 * Authorisation is NOT performed here — the caller must have cleared the call
 * through the policy engine first. What this does enforce, on every call and
 * independently of what the model asked for: input schema, rate limits, wall
 * clock, network egress, output size, secret leakage and injection scanning.
 */
export class ToolExecutor {
  private readonly limiter: TokenBucketLimiter;
  private readonly clock: Clock;

  constructor(private readonly options: ToolExecutorOptions) {
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new TokenBucketLimiter({ now: () => this.clock.now() });
  }

  /** Check rate limits without consuming the call's other budgets. */
  checkRateLimit(definition: ToolDefinition, scopeKey: string): { allowed: boolean; retryAfterMs: number } {
    if (!definition.rateLimit) return { allowed: true, retryAfterMs: 0 };
    const result = this.limiter.check(`${definition.name}:${scopeKey}`, definition.rateLimit);
    return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
  }

  async execute(call: ToolCall, options: ExecuteOptions): Promise<ToolResult> {
    const definition = this.options.registry.get(call.name);
    const logger = (options.logger ?? this.options.logger ?? nullLogger).child({
      tool: call.name,
      executionId: options.executionId,
    });
    const started = this.clock.now();
    const warnings: ToolWarning[] = [];

    // 1. Input validation. The model's arguments are untrusted input.
    const args = applyDefaults(call.arguments, definition.inputSchema);
    if (!isJsonObject(args)) {
      throw new AgentOSError('schema_invalid', `tool ${call.name} arguments must be an object`);
    }
    const validation = validateSchema(args, definition.inputSchema);
    if (!validation.valid) {
      throw new AgentOSError('schema_invalid', `invalid arguments for ${call.name}: ${describeViolations(validation.errors)}`, {
        details: { errors: validation.errors as unknown as JsonValue[] },
      });
    }

    // 2. Rate limiting, scoped to the agent so one agent cannot starve another.
    const rate = this.checkRateLimit(definition, `${options.orgId}:${options.agentId}`);
    if (!rate.allowed) {
      throw new AgentOSError('rate_limited', `tool ${call.name} is rate limited`, {
        details: { retryAfterMs: rate.retryAfterMs, tool: call.name },
      });
    }

    // 3. Context. Secrets resolve inside the handler, never before.
    const usedSecrets = new Set<string>();
    const baseRedactor = options.redactor ?? new Redactor();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? definition.timeoutMs;
    const timer = setTimeout(
      () => controller.abort(new AgentOSError('timeout', `tool ${call.name} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const context: ToolContext = {
      orgId: options.orgId,
      agentId: options.agentId,
      executionId: options.executionId,
      secrets: options.secrets,
      logger,
      clock: this.clock,
      signal: controller.signal,
      redactor: baseRedactor,
      usedSecrets,
      fetch: createGuardedFetch({
        isHostAllowed: options.isHostAllowed,
        fetchImpl: this.options.fetchImpl,
        resolveHost: this.options.resolveHost,
        allowPrivateAddresses: this.options.allowPrivateAddresses,
        timeoutMs,
      }),
    };

    let raw: JsonValue;
    try {
      raw = await Promise.race([
        definition.handler(args, context),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              const reason = controller.signal.reason;
              reject(
                AgentOSError.is(reason)
                  ? reason
                  : new AgentOSError('timeout', `tool ${call.name} was aborted`),
              );
            },
            { once: true },
          );
        }),
      ]);
    } catch (error) {
      throw AgentOSError.is(error)
        ? error
        : new AgentOSError('tool_error', `tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
            details: { tool: call.name },
          });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    // 4. Output schema. Drift is reported, not silently accepted.
    if (definition.outputSchema) {
      const outValidation = validateSchema(raw, definition.outputSchema);
      if (!outValidation.valid) {
        const detail = describeViolations(outValidation.errors);
        if (this.options.strictOutputSchema) {
          throw new AgentOSError('schema_invalid', `tool ${call.name} returned an invalid result: ${detail}`);
        }
        warnings.push({ kind: 'schema_mismatch', severity: 'low', detail });
      }
    }

    // 5. Secret leakage: a tool must not hand a credential back to the model.
    const redactor = usedSecrets.size > 0 ? baseRedactor.withLiterals(usedSecrets) : baseRedactor;
    const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
    if (usedSecrets.size > 0 && baseRedactor.withLiterals(usedSecrets).containsLiteral(serialized)) {
      warnings.push({
        kind: 'secret_in_output',
        severity: 'high',
        detail: `output of ${call.name} contained a resolved secret value; it was redacted`,
      });
      logger.warn('tool output contained a secret value', { tool: call.name });
    }

    // 6. Injection heuristics on untrusted content.
    const scan = scanForInjection(raw);
    warnings.push(...scan.warnings);

    // 7. Size cap, then redaction.
    const maxBytes = this.options.maxOutputBytes ?? 64_000;
    let output = redactor.value(raw);
    const outputSize = JSON.stringify(output ?? null).length;
    if (outputSize > maxBytes) {
      const asText = typeof output === 'string' ? output : JSON.stringify(output);
      output = `${asText.slice(0, maxBytes)}…[truncated ${outputSize - maxBytes} bytes]`;
      warnings.push({
        kind: 'oversized_output',
        severity: 'low',
        detail: `output truncated from ${outputSize} to ${maxBytes} bytes`,
      });
    }

    return {
      toolName: call.name,
      output,
      durationMs: this.clock.now() - started,
      warnings,
    };
  }
}

export function toolArgs(call: ToolCall): JsonObject {
  return isJsonObject(call.arguments) ? call.arguments : {};
}
