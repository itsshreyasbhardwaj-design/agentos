import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardHeader, ErrorState, Mono, PageHeader, Stat, StatusBadge } from '@/components/ui';
import { api, load } from '@/lib/api';
import { absoluteTime, duration, plural, relativeTime, usd } from '@/lib/format';
import { ExecutionActions } from './actions';

export const dynamic = 'force-dynamic';

const NODE_COLOR: Record<string, string> = {
  model: 'var(--accent)',
  tool: 'var(--info)',
  approval: 'var(--warn)',
  memory: 'var(--text-faint)',
  execution: 'var(--text-muted)',
};

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="max-h-64 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-words"
      style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}
    >
      {text}
    </pre>
  );
}

export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await load(async () => {
    const c = api();
    const execution = await c.executions.get(id);
    const [trace, agent] = await Promise.all([
      c.executions.trace(id),
      c.agents.get(execution.agentId).catch(() => null),
    ]);
    return { execution, trace, agent };
  });

  if (result.error) {
    if (result.error.message.includes('not found')) notFound();
    return (
      <>
        <PageHeader title="Execution" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { execution, trace, agent } = result.data;
  const elapsed = execution.finishedAt && execution.startedAt ? execution.finishedAt - execution.startedAt : null;

  return (
    <>
      <PageHeader
        title={agent?.name ?? 'Execution'}
        description={execution.id}
        action={<ExecutionActions executionId={execution.id} status={execution.status} mode={execution.mode} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={execution.status} />
        <Badge tone={execution.mode === 'replay' ? 'info' : execution.mode === 'demo' ? 'warn' : 'neutral'}>
          {execution.mode}
        </Badge>
        <Badge>trigger: {execution.trigger.type}</Badge>
        {agent ? <Badge>v{execution.versionNumber}</Badge> : null}
        {execution.replayOfExecutionId ? (
          <Link href={`/executions/${execution.replayOfExecutionId}`}>
            <Badge tone="info">replay of {execution.replayOfExecutionId.slice(0, 12)}…</Badge>
          </Link>
        ) : null}
        {execution.attempt > 0 ? <Badge tone="warn">attempt {execution.attempt + 1}</Badge> : null}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Duration" value={duration(elapsed)} hint={absoluteTime(execution.startedAt)} />
        <Stat label="Steps" value={execution.usage.steps} hint={plural(execution.usage.modelCalls, 'model call')} />
        <Stat label="Tool calls" value={execution.usage.toolCalls} hint={plural(execution.usage.approvals, 'approval')} />
        <Stat
          label="Tokens"
          value={execution.usage.totalTokens.toLocaleString()}
          hint={`${execution.usage.inputTokens.toLocaleString()} in / ${execution.usage.outputTokens.toLocaleString()} out`}
        />
        <Stat label="Cost" value={usd(execution.usage.costMicroUsd)} hint="estimated from list prices" />
      </div>

      {execution.error ? (
        <Card className="mt-4">
          <CardHeader title="Error" />
          <div className="px-5 py-4">
            <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
              {execution.error.code}
            </p>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {execution.error.message}
            </p>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              {execution.error.retryable ? 'This error is retryable.' : 'This error is terminal; retrying would not help.'}
            </p>
          </div>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader
          title="Trace"
          subtitle={`${trace.nodes.length} spans, reconstructed from ${trace.eventCount} recorded events`}
        />
        {trace.nodes.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No spans recorded yet.
          </div>
        ) : (
          <ol className="px-5 py-4">
            {trace.nodes.map((node, index) => (
              <li key={`${node.id}-${index}`} className="relative flex gap-4 pb-5 last:pb-0">
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden
                    className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: NODE_COLOR[node.kind] ?? 'var(--text-faint)' }}
                  />
                  {index < trace.nodes.length - 1 ? (
                    <span aria-hidden className="mt-1 w-px flex-1" style={{ background: 'var(--border)' }} />
                  ) : null}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: NODE_COLOR[node.kind] }}>
                      {node.kind}
                    </span>
                    <span className="font-mono text-xs">{node.name}</span>
                    <StatusBadge status={node.status} />
                    <span className="tabular text-xs" style={{ color: 'var(--text-faint)' }}>
                      {duration(node.durationMs)}
                    </span>
                    {node.costMicroUsd !== null ? (
                      <span className="tabular text-xs" style={{ color: 'var(--text-faint)' }}>
                        {usd(node.costMicroUsd)}
                      </span>
                    ) : null}
                    {node.inputTokens !== null ? (
                      <span className="tabular text-xs" style={{ color: 'var(--text-faint)' }}>
                        {node.inputTokens}→{node.outputTokens} tok
                      </span>
                    ) : null}
                  </div>

                  {node.detail ? (
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {node.detail}
                    </p>
                  ) : null}

                  {node.input || node.output ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-faint)' }}>
                        payload
                      </summary>
                      <div className="mt-2 grid gap-2 lg:grid-cols-2">
                        {node.input ? (
                          <div>
                            <p className="mb-1 text-[10px] uppercase" style={{ color: 'var(--text-faint)' }}>
                              input
                            </p>
                            <Json value={node.input} />
                          </div>
                        ) : null}
                        {node.output ? (
                          <div>
                            <p className="mb-1 text-[10px] uppercase" style={{ color: 'var(--text-faint)' }}>
                              output
                            </p>
                            <Json value={node.output} />
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="border-t px-5 py-3 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
          Values are redacted before they are written to the event log; secrets never reach this view.
        </p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Input" />
          <div className="px-5 py-4">
            <Json value={execution.input} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Output" subtitle={execution.finishedAt ? relativeTime(execution.finishedAt) : 'not finished'} />
          <div className="px-5 py-4">
            <Json value={execution.output} />
          </div>
        </Card>
      </div>
    </>
  );
}
