import {
  AgentOSError,
  DEFAULT_LIMITS,
  err,
  hashJson,
  newId,
  type AgentRecord,
  type AgentSpec,
  type AgentVersionRecord,
  type Principal,
} from '@agentos/core';
import type { RuntimeContext } from './context.js';
import { validateAgentSpec } from './validate.js';

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  spec: Partial<AgentSpec> & Pick<AgentSpec, 'model' | 'instructions'>;
  labels?: Record<string, string>;
}

export interface PublishOptions {
  changelog?: string;
  /** Publish even when the spec is byte-identical to the current version. */
  force?: boolean;
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** Agent definition lifecycle: draft → published version → rollback. */
export class AgentService {
  constructor(private readonly ctx: RuntimeContext) {}

  private fillSpec(partial: CreateAgentInput['spec']): AgentSpec {
    return {
      tools: [],
      permissions: { allowedTools: [], allowedOperations: [] },
      limits: DEFAULT_LIMITS,
      policies: [],
      ...partial,
    };
  }

  async create(principal: Principal, input: CreateAgentInput): Promise<AgentRecord> {
    if (!SLUG_PATTERN.test(input.slug)) {
      throw err.invalid(`agent slug must match ${SLUG_PATTERN} (lowercase, hyphenated)`);
    }
    const spec = this.fillSpec(input.spec);
    validateAgentSpec(spec, this.ctx.registry);

    const now = this.ctx.clock.now();
    const agent = await this.ctx.store.agents.create({
      id: newId('agent'),
      orgId: principal.orgId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      draft: spec,
      publishedVersionId: null,
      latestVersionNumber: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: principal.userId,
      archived: false,
      labels: input.labels ?? {},
    });
    await this.audit(principal, 'agent.created', agent.id, { slug: agent.slug });
    return agent;
  }

  async updateDraft(
    principal: Principal,
    agentId: string,
    patch: { name?: string; description?: string; spec?: Partial<AgentSpec>; labels?: Record<string, string> },
  ): Promise<AgentRecord> {
    const agent = await this.get(principal.orgId, agentId);
    const spec = patch.spec ? ({ ...agent.draft, ...patch.spec } as AgentSpec) : agent.draft;
    if (patch.spec) validateAgentSpec(spec, this.ctx.registry);

    const updated = await this.ctx.store.agents.update(principal.orgId, agentId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
      draft: spec,
      updatedAt: this.ctx.clock.now(),
    });
    await this.audit(principal, 'agent.draft_updated', agentId, {});
    return updated;
  }

  async get(orgId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.ctx.store.agents.get(orgId, agentId);
    if (!agent) throw err.notFound('agent', agentId);
    return agent;
  }

  async getBySlugOrId(orgId: string, ref: string): Promise<AgentRecord> {
    const byId = await this.ctx.store.agents.get(orgId, ref);
    if (byId) return byId;
    const bySlug = await this.ctx.store.agents.getBySlug(orgId, ref);
    if (!bySlug) throw err.notFound('agent', ref);
    return bySlug;
  }

  /**
   * Freeze the draft into an immutable version and make it current.
   *
   * Executions always reference a version id, never the draft, so editing an
   * agent can never change what a run in flight is doing.
   */
  async publish(principal: Principal, agentId: string, options: PublishOptions = {}): Promise<AgentVersionRecord> {
    const agent = await this.get(principal.orgId, agentId);
    validateAgentSpec(agent.draft, this.ctx.registry);

    const specHash = hashJson(agent.draft);
    if (!options.force && agent.publishedVersionId) {
      const current = await this.ctx.store.agents.getVersion(principal.orgId, agent.publishedVersionId);
      if (current?.specHash === specHash) {
        throw err.conflict('the draft is identical to the published version; nothing to publish', {
          versionId: current.id,
        });
      }
    }

    const now = this.ctx.clock.now();
    const version = await this.ctx.store.agents.createVersion({
      id: newId('version'),
      agentId: agent.id,
      orgId: agent.orgId,
      version: agent.latestVersionNumber + 1,
      spec: agent.draft,
      status: 'published',
      changelog: options.changelog ?? '',
      publishedAt: now,
      publishedBy: principal.userId,
      specHash,
    });

    await this.ctx.store.agents.update(principal.orgId, agentId, {
      publishedVersionId: version.id,
      latestVersionNumber: version.version,
      updatedAt: now,
    });
    await this.audit(principal, 'agent.published', agentId, { version: version.version, versionId: version.id });
    return version;
  }

  /** Point the agent back at an earlier version without losing history. */
  async rollback(principal: Principal, agentId: string, versionId: string): Promise<AgentRecord> {
    const agent = await this.get(principal.orgId, agentId);
    const version = await this.ctx.store.agents.getVersion(principal.orgId, versionId);
    if (!version || version.agentId !== agent.id) throw err.notFound('agent version', versionId);

    const updated = await this.ctx.store.agents.update(principal.orgId, agentId, {
      publishedVersionId: version.id,
      draft: version.spec,
      updatedAt: this.ctx.clock.now(),
    });
    await this.audit(principal, 'agent.rolled_back', agentId, { toVersion: version.version });
    return updated;
  }

  async publishedVersion(orgId: string, agent: AgentRecord): Promise<AgentVersionRecord> {
    if (!agent.publishedVersionId) {
      throw new AgentOSError('conflict', `agent ${agent.slug} has no published version; publish it before running`, {
        details: { agentId: agent.id },
      });
    }
    const version = await this.ctx.store.agents.getVersion(orgId, agent.publishedVersionId);
    if (!version) throw err.notFound('agent version', agent.publishedVersionId);
    return version;
  }

  async archive(principal: Principal, agentId: string): Promise<boolean> {
    const archived = await this.ctx.store.agents.archive(principal.orgId, agentId);
    if (archived) await this.audit(principal, 'agent.archived', agentId, {});
    return archived;
  }

  private async audit(
    principal: Principal,
    action: string,
    resourceId: string,
    metadata: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.ctx.store.audit.record({
      id: newId('audit'),
      orgId: principal.orgId,
      actorId: principal.apiKeyId ?? principal.userId,
      actorType: principal.apiKeyId ? 'api_key' : 'user',
      action,
      resourceType: 'agent',
      resourceId,
      at: this.ctx.clock.now(),
      metadata,
      ip: null,
    });
  }
}
