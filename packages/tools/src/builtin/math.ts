import { AgentOSError } from '@agentos/core';

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'name'; value: string };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  pow: Math.pow,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j] as string)) j += 1;
      const raw = input.slice(i, j).replace(/_/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new AgentOSError('invalid_request', `invalid number '${raw}'`);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new AgentOSError('invalid_request', `unexpected character '${ch}' in expression`);
  }
  return tokens;
}

/**
 * Arithmetic evaluator built on an explicit parser.
 *
 * Deliberately not `eval`, `Function` or a sandboxed VM: a tool an agent can
 * reach must not be able to become arbitrary code execution, however convenient
 * that would be to implement.
 */
export function evaluateExpression(expression: string): number {
  if (expression.length > 500) throw new AgentOSError('invalid_request', 'expression is too long');
  const tokens = tokenize(expression);
  const output: number[] = [];
  const operators: Token[] = [];
  let expectValue = true;

  const applyOperator = (op: string): void => {
    if (op === 'u-') {
      const a = output.pop();
      if (a === undefined) throw new AgentOSError('invalid_request', 'malformed expression');
      output.push(-a);
      return;
    }
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) throw new AgentOSError('invalid_request', 'malformed expression');
    switch (op) {
      case '+': output.push(a + b); break;
      case '-': output.push(a - b); break;
      case '*': output.push(a * b); break;
      case '/':
        if (b === 0) throw new AgentOSError('invalid_request', 'division by zero');
        output.push(a / b);
        break;
      case '%':
        if (b === 0) throw new AgentOSError('invalid_request', 'modulo by zero');
        output.push(a % b);
        break;
      case '^': output.push(a ** b); break;
      default: throw new AgentOSError('invalid_request', `unknown operator '${op}'`);
    }
  };

  const applyFunction = (name: string, argCount: number): void => {
    const fn = FUNCTIONS[name];
    if (!fn) throw new AgentOSError('invalid_request', `unknown function '${name}'`);
    const args = output.splice(output.length - argCount, argCount);
    if (args.length !== argCount) throw new AgentOSError('invalid_request', `bad arguments for '${name}'`);
    output.push(fn(...args));
  };

  const argCounts: number[] = [];

  for (const token of tokens) {
    if (token.kind === 'num') {
      output.push(token.value);
      expectValue = false;
      continue;
    }
    if (token.kind === 'name') {
      if (token.value in CONSTANTS) {
        output.push(CONSTANTS[token.value] as number);
        expectValue = false;
      } else {
        operators.push(token);
        argCounts.push(1);
      }
      continue;
    }
    if (token.value === '(') {
      operators.push(token);
      expectValue = true;
      continue;
    }
    if (token.value === ',') {
      while (operators.length > 0 && operators[operators.length - 1]?.value !== '(') {
        applyOperator(String(operators.pop()?.value));
      }
      argCounts[argCounts.length - 1] = (argCounts[argCounts.length - 1] ?? 1) + 1;
      expectValue = true;
      continue;
    }
    if (token.value === ')') {
      while (operators.length > 0 && operators[operators.length - 1]?.value !== '(') {
        applyOperator(String(operators.pop()?.value));
      }
      if (operators.pop()?.value !== '(') throw new AgentOSError('invalid_request', 'unbalanced parentheses');
      const top = operators[operators.length - 1];
      if (top?.kind === 'name') {
        operators.pop();
        applyFunction(top.value, argCounts.pop() ?? 1);
      }
      expectValue = false;
      continue;
    }

    const op = token.value === '-' && expectValue ? 'u-' : token.value;
    const precedence = op === 'u-' ? 4 : (PRECEDENCE[op] ?? 0);
    while (operators.length > 0) {
      const top = operators[operators.length - 1];
      if (!top || top.value === '(' || top.kind === 'name') break;
      const topPrecedence = top.value === 'u-' ? 4 : (PRECEDENCE[String(top.value)] ?? 0);
      if (topPrecedence < precedence || (topPrecedence === precedence && op === '^')) break;
      applyOperator(String(operators.pop()?.value));
    }
    operators.push({ kind: 'op', value: op });
    expectValue = true;
  }

  while (operators.length > 0) {
    const op = operators.pop();
    if (op?.value === '(') throw new AgentOSError('invalid_request', 'unbalanced parentheses');
    applyOperator(String(op?.value));
  }

  const result = output.pop();
  if (result === undefined || output.length > 0) {
    throw new AgentOSError('invalid_request', 'malformed expression');
  }
  if (!Number.isFinite(result)) throw new AgentOSError('invalid_request', 'expression did not produce a finite number');
  return result;
}
