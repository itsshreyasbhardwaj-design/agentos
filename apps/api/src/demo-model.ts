import { isJsonObject, type JsonObject } from '@agentos/core';
import type { ScriptContext, ScriptedTurn } from '@agentos/providers';

/**
 * A deterministic stand-in for a language model.
 *
 * It is NOT an LLM and does not pretend to be one: it is a small rule-based
 * responder that lets the demo environment exercise the full runtime — tool
 * calls, approvals, limits, traces — with no API key and no spend. Every
 * execution it drives is recorded with `provider: scripted`, and the demo
 * agents are labelled as demo data in the dashboard.
 *
 * Point an agent at a real provider (`openai:`, `anthropic:`, `ollama:` …) and
 * nothing else about the runtime changes.
 */
export function demoScript(context: ScriptContext): ScriptedTurn {
  const { messages } = context;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const toolResults = messages.filter((m) => m.role === 'tool');
  const prompt = (lastUser && lastUser.role === 'user' ? lastUser.content : '').toLowerCase();

  const wantsJson = messages.some(
    (m) => m.role === 'system' && m.content.includes('Your final answer must be JSON'),
  );

  // Once a tool has answered, summarise rather than looping.
  if (toolResults.length > 0) {
    const last = toolResults[toolResults.length - 1];
    const body = last && last.role === 'tool' ? last.content : '';
    const failed = last && last.role === 'tool' ? last.isError === true : false;

    if (failed) {
      return wantsJson
        ? {
            content: JSON.stringify({ summary: `the tool failed: ${body.slice(0, 200)}`, confidence: 0, sources: [] }),
            finishReason: 'stop',
          }
        : {
            content: `I could not complete that step. The tool reported: ${body.slice(0, 300)}`,
            finishReason: 'stop',
          };
    }

    // If the agent can publish and was asked to, take the write action — which
    // is what makes the approval gate visible in the demo.
    const canPost = (context.request.tools ?? []).some((t) => t.name === 'demo.post_review');
    const alreadyPosted = messages.some((m) => m.role === 'tool' && m.name === 'demo.post_review');
    if (canPost && !alreadyPosted && /post|publish|comment|review/.test(prompt)) {
      return {
        toolCalls: [
          {
            name: 'demo.post_review',
            arguments: {
              target: 'pull-request',
              body: 'Finding: the token comparison in src/auth.ts is not constant time.',
            } as JsonObject,
          },
        ],
      };
    }

    // Pull the value back out of the fenced tool output for a tidy answer.
    const computed = /"result"\s*:\s*(-?[\d.]+)/.exec(body)?.[1] ?? null;
    if (wantsJson) {
      return {
        content: JSON.stringify({
          summary: computed === null ? body.slice(0, 300) : `The result is ${computed}.`,
          confidence: computed === null ? 0.4 : 0.9,
          sources: ['math.evaluate'],
        }),
        finishReason: 'stop',
      };
    }
    return {
      content:
        computed === null
          ? `Here is what I found.\n\n${body.slice(0, 600)}\n\n(Deterministic demo model — no language model was called.)`
          : `The result is ${computed}. (Deterministic demo model — no language model was called.)`,
      finishReason: 'stop',
    };
  }

  const demoDocument = /\b(status-page|pull-request|metrics)\b/.exec(prompt);
  if (demoDocument?.[1]) {
    return { toolCalls: [{ name: 'demo.fetch_page', arguments: { document: demoDocument[1] } as JsonObject }] };
  }

  const arithmetic = /(-?\d+(?:\.\d+)?\s*[-+*/^]\s*-?\d+(?:\.\d+)?(?:\s*[-+*/^]\s*-?\d+(?:\.\d+)?)*)/.exec(prompt);
  if (arithmetic?.[1]) {
    return { toolCalls: [{ name: 'math.evaluate', arguments: { expression: arithmetic[1].trim() } as JsonObject }] };
  }

  const url = /https?:\/\/[^\s"')]+/.exec(prompt);
  if (url?.[0]) {
    return { toolCalls: [{ name: 'http.get', arguments: { url: url[0] } as JsonObject }] };
  }

  if (prompt.includes('time') || prompt.includes('date')) {
    return { toolCalls: [{ name: 'time.now', arguments: {} }] };
  }

  if (wantsJson) {
    return {
      content: JSON.stringify({ summary: 'demo response', confidence: 0.5, sources: [] }),
      finishReason: 'stop',
    };
  }

  return {
    content:
      'This is the deterministic demo model. It answers arithmetic, fetches URLs it is given and reports the ' +
      'time; anything else gets this message. Configure a real provider to see model reasoning.',
    finishReason: 'stop',
  };
}

export function isDemoInput(value: unknown): value is JsonObject {
  return isJsonObject(value);
}
