import type { JsonObject, JsonValue } from './json.js';

export interface ToolCall {
  /** Provider-assigned call id; unique within an execution. */
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}
export interface UserMessage {
  role: 'user';
  content: string;
}
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
}
export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  /**
   * Provenance of the content. Anything a tool returned is `untrusted`: it may
   * contain attacker-controlled text. The runtime never lets untrusted content
   * widen permissions — enforcement happens outside the model.
   */
  trust: 'trusted' | 'untrusted';
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}
export function userMessage(content: string): UserMessage {
  return { role: 'user', content };
}
export function assistantMessage(content: string | null, toolCalls?: ToolCall[]): AssistantMessage {
  return toolCalls && toolCalls.length > 0
    ? { role: 'assistant', content, toolCalls }
    : { role: 'assistant', content };
}
export function toolMessage(
  call: Pick<ToolCall, 'id' | 'name'>,
  content: JsonValue,
  options: { isError?: boolean; trust?: 'trusted' | 'untrusted' } = {},
): ToolMessage {
  return {
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    isError: options.isError ?? false,
    trust: options.trust ?? 'untrusted',
  };
}
