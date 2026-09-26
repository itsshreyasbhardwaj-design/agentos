import type { JsonValue } from './json.js';
import { defaultRedactor, type Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: JsonValue | undefined;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  redactor?: Redactor;
  sink?: (line: string) => void;
}

/** Structured JSON logger. Every field passes through the redactor first. */
export class JsonLogger implements Logger {
  private readonly level: LogLevel;
  private readonly base: LogFields;
  private readonly redactor: Redactor;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';
    this.base = options.base ?? {};
    this.redactor = options.redactor ?? defaultRedactor;
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const merged: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries({ ...this.base, ...(fields ?? {}) })) {
      if (v !== undefined) merged[k] = v;
    }
    const payload = {
      level,
      time: new Date().toISOString(),
      msg: this.redactor.string(message),
      ...(this.redactor.value(merged) as Record<string, JsonValue>),
    };
    this.sink(JSON.stringify(payload));
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({
      level: this.level,
      base: { ...this.base, ...fields },
      redactor: this.redactor,
      sink: this.sink,
    });
  }
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
