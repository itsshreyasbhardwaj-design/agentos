import { AgentOSError, anyGlobMatch } from '@agentos/core';
import type { ModelToolSpec } from '@agentos/providers';
import type { ToolDefinition } from './types.js';

/**
 * The set of tools the runtime knows about. Registration is an operator action:
 * a model can never add a tool, and an agent only sees the subset its permission
 * allow-list matches.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): this {
    if (this.tools.has(definition.name)) {
      throw new AgentOSError('conflict', `tool ${definition.name} is already registered`);
    }
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(definition.name)) {
      throw new AgentOSError(
        'invalid_request',
        `tool name '${definition.name}' must be lowercase dotted segments (e.g. github.list_issues)`,
      );
    }
    this.tools.set(definition.name, definition);
    return this;
  }

  registerAll(definitions: ToolDefinition[]): this {
    for (const d of definitions) this.register(d);
    return this;
  }

  replace(definition: ToolDefinition): this {
    this.tools.delete(definition.name);
    return this.register(definition);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Remove every tool contributed by one MCP server. */
  unregisterServer(serverId: string): number {
    let removed = 0;
    for (const [name, def] of this.tools) {
      if (def.serverId === serverId) {
        this.tools.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentOSError('tool_not_found', `tool ${name} is not registered`, { details: { name } });
    }
    return tool;
  }

  find(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Tools matching an agent's allow-list globs, minus its deny-list. */
  forAgent(allowed: string[], denied: string[] = []): ToolDefinition[] {
    return this.list().filter((t) => anyGlobMatch(allowed, t.name) && !anyGlobMatch(denied, t.name));
  }

  /** Project tool definitions into the shape a model provider expects. */
  toModelSpecs(tools: ToolDefinition[]): ModelToolSpec[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.destructive ? `${t.description} (destructive; may require human approval)` : t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
