import { isJsonObject, type JsonValue } from './json.js';

/**
 * The JSON Schema subset AgentOS accepts for tool inputs and outputs. It is
 * deliberately small: every keyword here is one a model provider can also be
 * told about, so what we validate is exactly what the model was shown.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  format?: 'uri' | 'email' | 'date-time' | 'uuid';
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  default?: JsonValue;
  anyOf?: JsonSchema[];
  nullable?: boolean;
}

export interface SchemaViolation {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: SchemaViolation[];
}

const FORMAT_CHECKS: Record<NonNullable<JsonSchema['format']>, (v: string) => boolean> = {
  uri: (v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  'date-time': (v) => !Number.isNaN(Date.parse(v)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
};

function typeOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(value: JsonValue, schema: JsonSchema, path: string, errors: SchemaViolation[]): void {
  if (schema.nullable && value === null) return;

  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchErrors: SchemaViolation[][] = [];
    for (const branch of schema.anyOf) {
      const local: SchemaViolation[] = [];
      validateNode(value, branch, path, local);
      if (local.length === 0) return;
      branchErrors.push(local);
    }
    errors.push({ path, message: `does not match any allowed schema (${branchErrors.length} branches)` });
    return;
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
    return;
  }

  if (schema.type) {
    const actual = typeOf(value);
    const ok =
      schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : actual === schema.type;
    if (!ok) {
      errors.push({ path, message: `expected ${schema.type}, received ${actual}` });
      return;
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `must match ${schema.pattern}` });
    }
    if (schema.format && !FORMAT_CHECKS[schema.format](value)) {
      errors.push({ path, message: `must be a valid ${schema.format}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items as JsonSchema, `${path}[${i}]`, errors));
    }
  }

  if (isJsonObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = props[key];
      const childPath = path ? `${path}.${key}` : key;
      if (childSchema) {
        validateNode(child, childSchema, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath, message: 'is not an allowed property' });
      } else if (isJsonObject(schema.additionalProperties)) {
        validateNode(child, schema.additionalProperties, childPath, errors);
      }
    }
  }
}

export function validateSchema(value: JsonValue, schema: JsonSchema): ValidationResult {
  const errors: SchemaViolation[] = [];
  validateNode(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

/** Fill in `default`s for absent top-level properties. Does not mutate input. */
export function applyDefaults(value: JsonValue, schema: JsonSchema): JsonValue {
  if (!isJsonObject(value) || !schema.properties) return value;
  const out: Record<string, JsonValue> = { ...value };
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!(key in out) && child.default !== undefined) out[key] = child.default;
  }
  return out;
}

export function describeViolations(errors: SchemaViolation[]): string {
  return errors.map((e) => `${e.path || '<root>'}: ${e.message}`).join('; ');
}
