import Link from 'next/link';
import { Card, EmptyState, ErrorState, Mono, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { duration, relativeTime, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

const FILTERS = ['all', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;

export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const { status, cursor } = await searchParams;
  const result = await load(async () => {
    const c = api();
    const [executions, agents] = await Promise.all([
      c.executions.list({
        limit: 50,
        ...(status && status !== 'all' ? { status: [status] } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      c.agents.list({ limit: 100 }),
    ]);
    return { executions, agents };
  });

  if (result.error) {
    return (
      <>
        <PageHeader title="Executions" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { executions, agents } = result.data;
  const agentName = (id: string) => agents.items.find((a) => a.id === id)?.name ?? id;
  const current = status ?? 'all';

  return (
    <>
      <PageHeader title="Executions" description="Every run, live and historical." />

      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map((filter) => (
          <Link
            key={filter}
            href={filter === 'all' ? '/executions' : `/executions?status=${filter}`}
            aria-current={current === filter ? 'true' : undefined}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{
              background: current === filter ? 'var(--bg-hover)' : 'transparent',
              color: current === filter ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            {filter.replace(/_/g, ' ')}
          </Link>
        ))}
      </nav>

      <Card>
        {executions.items.length === 0 ? (
          <EmptyState title="Nothing here" body="No execution matches this filter." />
        ) : (
          <Table caption="Executions">
            <thead>
              <tr>
                <Th>Execution</Th>
                <Th>Agent</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th className="text-right">Steps</Th>
                <Th className="text-right">Duration</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {executions.items.map((execution) => (
                <tr key={execution.id}>
                  <Td>
                    <Link href={`/executions/${execution.id}`} className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                      {execution.id.slice(0, 18)}…
                    </Link>
                    {execution.mode !== 'live' ? (
                      <span className="ml-2 text-[10px] uppercase" style={{ color: 'var(--text-faint)' }}>
                        {execution.mode}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-sm">{agentName(execution.agentId)}</Td>
                  <Td>
                    <Mono>{execution.trigger.type}</Mono>
                  </Td>
                  <Td>
                    <StatusBadge status={execution.status} />
                  </Td>
                  <Td className="tabular text-right text-xs">{execution.usage.steps}</Td>
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

      {executions.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Link
            href={`/executions?${status ? `status=${status}&` : ''}cursor=${executions.nextCursor}`}
            className="rounded-md border px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
          >
            Load more
          </Link>
        </div>
      ) : null}
    </>
  );
}
