import { isJsonObject, type JsonValue } from './json.js';

export const REDACTED = '[redacted]';

/** Keys whose values never leave the process in clear text. */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|session[-_]?id|cookie|bearer|access[-_]?key|refresh[-_]?token|client[-_]?secret|signature|ssn|card[-_]?number|cvv)/i;

/** Shapes that look like credentials even when the key is innocuous. */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer_header', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'pem_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export interface RedactorOptions {
  /** Literal values (resolved secrets) to scrub wherever they appear. */
  literals?: Iterable<string>;
  maxStringLength?: number;
}

export class Redactor {
  private readonly literals: string[];
  private readonly maxStringLength: number;

  constructor(options: RedactorOptions = {}) {
    this.literals = [...(options.literals ?? [])].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
    this.maxStringLength = options.maxStringLength ?? 16_384;
  }

  withLiterals(literals: Iterable<string>): Redactor {
    return new Redactor({
      literals: [...this.literals, ...literals],
      maxStringLength: this.maxStringLength,
    });
  }

  string(input: string): string {
    let out = input;
    for (const literal of this.literals) {
      if (literal && out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    for (const { re } of VALUE_PATTERNS) {
      out = out.replace(new RegExp(re.source, re.flags), REDACTED);
    }
    if (out.length > this.maxStringLength) {
      out = `${out.slice(0, this.maxStringLength)}…[truncated ${out.length - this.maxStringLength} chars]`;
    }
    return out;
  }

  value(input: JsonValue): JsonValue {
    if (typeof input === 'string') return this.string(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v));
    if (isJsonObject(input)) {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(input)) {
        out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : this.value(v);
      }
      return out;
    }
    return input;
  }

  /** True when the text still contains any of the tracked literals. */
  containsLiteral(text: string): boolean {
    return this.literals.some((l) => l.length > 0 && text.includes(l));
  }
}

export const defaultRedactor = new Redactor();

export function redact(value: JsonValue, literals?: Iterable<string>): JsonValue {
  return (literals ? new Redactor({ literals }) : defaultRedactor).value(value);
}
