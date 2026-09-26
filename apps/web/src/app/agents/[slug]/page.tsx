import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Mono,
  PageHeader,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api, load } from '@/lib/api';
import { absoluteTime, duration, percent, relativeTime, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-4 border-t px-5 py-3 text-sm" style={{ borderColor: 'var(--border)' }}>
      <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export default async function AgentDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await load(async () => {
    const c = api();
    const agent = await c.agents.get(slug);
    const [versions, metrics, executions] = await Promise.all([
      c.agents.versions(slug),
      c.agents.metrics(slug),
      c.executions.list({ agentId: agent.id, limit: 10 }),
    ]);
    return { agent, versions, metrics, executions };
  });

  if (result.error) {
    if (result.error.message.includes('not found')) notFound();
    return (
      <>
        <PageHeader title={slug} />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { agent, versions, metrics, executions } = result.data;
  const spec = agent.draft;
  const permissions = spec.permissions;

  return (
    <>
      <PageHeader
        title={agent.name}
        description={agent.description}
        action={
          <div className="flex items-center gap-2">
            {agent.publishedVersionId ? <Badge tone="ok">published v{agent.latestVersionNumber}</Badge> : <Badge tone="warn">draft only</Badge>}
            <Mono>{agent.slug}</Mono>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Executions" value={metrics.executions} hint="last 7 days" />
        <Stat
          label="Success rate"
          value={metrics.completed + metrics.failed === 0 ? '—' : percent(metrics.successRate)}
          hint={`${metrics.completed} ok · ${metrics.failed} failed`}
        />
        <Stat label="p95 duration" value={duration(metrics.p95DurationMs)} hint={`p50 ${duration(metrics.p50DurationMs)}`} />
        <Stat label="Cost" value={usd(metrics.totalCostMicroUsd)} hint={`${metrics.modelCalls} model calls`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Configuration" subtitle="The draft. Executions always run a published version." />
          <dl>
            <SpecRow label="Model">
              <Mono>{spec.model.primary}</Mono>
              {spec.model.fallbacks && spec.model.fallbacks.length > 0 ? (
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  falls back to {spec.model.fallbacks.map((m) => <Mono key={m}>{m} </Mono>)}
                </p>
              ) : null}
            </SpecRow>
            <SpecRow label="Instructions">
              <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                {spec.instructions}
              </p>
            </SpecRow>
            <SpecRow label="Tools">
              <div className="flex flex-wrap gap-1">
                {(permissions.allowedTools ?? []).map((tool) => (
                  <Badge key={tool} tone="accent">
                    {tool}
                  </Badge>
                ))}
                {(permissions.allowedTools ?? []).length === 0 ? <span className="text-xs">none</span> : null}
              </div>
            </SpecRow>
            <SpecRow label="Operations">
              <div className="flex flex-wrap gap-1">
                {(permissions.allowedOperations ?? []).map((op) => (
                  <Badge key={op} tone={op === 'delete' || op === 'exec' ? 'danger' : 'neutral'}>
                    {op}
                  </Badge>
                ))}
                {(permissions.allowedOperations ?? []).length === 0 ? <span className="text-xs">none</span> : null}
              </div>
            </SpecRow>
            <SpecRow label="Network">
              {(permissions.allowedDomains ?? []).length === 0 ? (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  no outbound network permitted
                </span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(permissions.allowedDomains ?? []).map((domain) => (
                    <Badge key={domain}>{domain}</Badge>
                  ))}
                </div>
              )}
            </SpecRow>
            <SpecRow label="Approval">
              {(permissions.requireApprovalFor ?? []).length === 0 ? (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  only the baseline rules (destructive and delete actions)
                </span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(permissions.requireApprovalFor ?? []).map((tool) => (
                    <Badge key={tool} tone="warn">
                      {tool}
                    </Badge>
                  ))}
                </div>
              )}
            </SpecRow>
            <SpecRow label="Limits">
              <ul className="tabular grid grid-cols-2 gap-x-6 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                <li>steps ≤ {spec.limits.maxSteps}</li>
                <li>model calls ≤ {spec.limits.maxModelCalls}</li>
                <li>tool calls ≤ {spec.limits.maxToolCalls}</li>
                <li>tokens ≤ {spec.limits.maxTokens.toLocaleString()}</li>
                <li>cost ≤ {usd(spec.limits.maxCostMicroUsd)}</li>
                <li>duration ≤ {duration(spec.limits.maxDurationMs)}</li>
              </ul>
              <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                On breach: {spec.limits.onExceeded}.
              </p>
            </SpecRow>
            <SpecRow label="Memory">
              {spec.memory ? (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {spec.memory.provider} · {spec.memory.scopes.join(', ')}
                </span>
              ) : (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  stateless
                </span>
              )}
            </SpecRow>
            {spec.delegatesTo && spec.delegatesTo.length > 0 ? (
              <SpecRow label="Delegates to">
                <div className="flex flex-wrap gap-1">
                  {spec.delegatesTo.map((target) => (
                    <Link key={target} href={`/agents/${target}`}>
                      <Badge tone="info">{target}</Badge>
                    </Link>
                  ))}
                </div>
              </SpecRow>
            ) : null}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Versions" subtitle="Immutable once published" />
          {versions.length === 0 ? (
            <EmptyState title="Never published" body="Publish the draft to make this agent runnable." />
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {versions.map((version) => (
                <li key={version.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">v{version.version}</span>
                    {version.id === agent.publishedVersionId ? <Badge tone="ok">current</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {version.changelog || 'no changelog'}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }} title={absoluteTime(version.publishedAt)}>
                    {relativeTime(version.publishedAt)} · <Mono>{version.specHash.slice(0, 12)}</Mono>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Recent executions" />
        {executions.items.length === 0 ? (
          <EmptyState title="No runs yet" body={`POST /v1/agents/${agent.slug}/run to start one.`} />
        ) : (
          <Table caption={`Recent executions for ${agent.name}`}>
            <thead>
              <tr>
                <Th>Execution</Th>
                <Th>Status</Th>
                <Th>Version</Th>
                <Th className="text-right">Duration</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Started</Th>
              </tr>
            </thead>
            <tbody>
              {executions.items.map((execution) => (
                <tr key={execution.id}>
                  <Td>
                    <Link href={`/executions/${execution.id}`} className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                      {execution.id.slice(0, 18)}…
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={execution.status} />
                  </Td>
                  <Td>
                    <Mono>v{execution.versionNumber}</Mono>
                  </Td>
                  <Td className="tabular text-right text-xs">
                    {duration(execution.finishedAt && execution.startedAt ? execution.finishedAt - execution.startedAt : null)}
                  </Td>
                  <Td className="tabular text-right text-xs">{usd(execution.usage.costMicroUsd)}</Td>
                  <Td className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                    {relativeTime(execution.createdAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
