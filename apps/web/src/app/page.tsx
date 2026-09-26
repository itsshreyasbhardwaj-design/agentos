import Link from 'next/link';
import { BarList, Card, CardHeader, EmptyState, ErrorState, Mono, PageHeader, Stat, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { count, duration, percent, relativeTime, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const client = load(() => {
    const c = api();
    return Promise.all([
      c.metrics.overview(),
      c.executions.list({ limit: 8 }),
      c.approvals.listPending({ limit: 5 }),
      c.metrics.costByAgent(),
      c.agents.list({ limit: 100 }),
    ]);
  });
  const result = await client;

  if (result.error) {
    return (
      <>
        <PageHeader title="Overview" description="Fleet health across the last 7 days." />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const [overview, executions, approvals, costByAgent, agents] = result.data;
  const settled = overview.completed + overview.failed;
  const agentName = (id: string) => agents.items.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Everything below is derived from recorded execution events. No sample data."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Executions" value={count(overview.executions)} hint="last 7 days" />
        <Stat
          label="Success rate"
          value={settled === 0 ? '—' : percent(overview.completed / settled)}
          hint={settled === 0 ? 'nothing has finished yet' : `${overview.completed} of ${settled} settled`}
          tone={settled === 0 ? 'neutral' : overview.failed === 0 ? 'ok' : 'neutral'}
        />
        <Stat label="Estimated cost" value={usd(overview.costMicroUsd)} hint={`${count(overview.totalTokens)} tokens`} />
        <Stat
          label="Awaiting approval"
          value={approvals.items.length}
          hint={approvals.items.length > 0 ? 'a human decision is blocking work' : 'nothing is blocked'}
          tone={approvals.items.length > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent executions"
            subtitle="Newest first"
            action={
              <Link href="/executions" className="text-xs" style={{ color: 'var(--accent)' }}>
                View all
              </Link>
            }
          />
          {executions.items.length === 0 ? (
            <EmptyState
              title="No executions yet"
              body="Run an agent from the Agents page, or POST to /v1/agents/{slug}/run, and it will appear here."
            />
          ) : (
            <Table caption="Recent executions">
              <thead>
                <tr>
                  <Th>Execution</Th>
                  <Th>Agent</Th>
                  <Th>Status</Th>
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
                        {execution.id.slice(0, 16)}…
                      </Link>
                      {execution.mode !== 'live' ? (
                        <span className="ml-2 text-[10px] uppercase" style={{ color: 'var(--text-faint)' }}>
                          {execution.mode}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-sm">{agentName(execution.agentId)}</span>
                      <Mono className="ml-2">v{execution.versionNumber}</Mono>
                    </Td>
                    <Td>
                      <StatusBadge status={execution.status} />
                    </Td>
                    <Td className="tabular text-right text-xs">
                      {duration(
                        execution.finishedAt && execution.startedAt ? execution.finishedAt - execution.startedAt : null,
                      )}
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

        <div className="space-y-4">
          <Card>
            <CardHeader title="Pending approvals" subtitle="Work paused for a human" />
            {approvals.items.length === 0 ? (
              <EmptyState title="Nothing waiting" body="No agent is currently blocked on a human decision." />
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {approvals.items.map((approval) => (
                  <li key={approval.id} className="px-5 py-3">
                    <Link href="/approvals" className="text-sm font-medium" style={{ color: 'var(--accent)' }}>
                      {approval.toolCall.name}
                    </Link>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {approval.impact}
                    </p>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {relativeTime(approval.requestedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Cost by agent" subtitle="Estimated, last 7 days" />
            {costByAgent.length === 0 ? (
              <EmptyState title="No spend recorded" body="Cost accrues as agents make model calls." />
            ) : (
              <BarList
                items={costByAgent.slice(0, 6).map((row) => ({
                  label: agentName(row.agentId),
                  value: row.costMicroUsd,
                  display: usd(row.costMicroUsd),
                }))}
              />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
