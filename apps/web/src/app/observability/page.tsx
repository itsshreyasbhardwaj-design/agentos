import { BarList, Card, CardHeader, EmptyState, ErrorState, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { count, duration, percent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ObservabilityPage() {
  const result = await load(async () => {
    const c = api();
    const [overview, toolUsage, byModel] = await Promise.all([
      c.metrics.overview(),
      c.metrics.toolUsage(),
      c.metrics.costByModel(),
    ]);
    return { overview, toolUsage, byModel };
  });

  if (result.error) {
    return (
      <>
        <PageHeader title="Observability" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { overview, toolUsage, byModel } = result.data;
  const settled = overview.completed + overview.failed;

  return (
    <>
      <PageHeader title="Observability" description="Aggregated from the execution event log." />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Executions" value={count(overview.executions)} />
        <Stat label="Success rate" value={settled === 0 ? '—' : percent(overview.completed / settled)} />
        <Stat label="Tool calls" value={count(overview.toolCalls)} />
        <Stat label="Human approvals" value={count(overview.approvals)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tool usage" subtitle="Calls and failures per tool" />
          {toolUsage.length === 0 ? (
            <EmptyState title="No tool calls recorded" body="Tool metrics appear once agents start calling tools." />
          ) : (
            <Table caption="Tool usage">
              <thead>
                <tr>
                  <Th>Tool</Th>
                  <Th className="text-right">Calls</Th>
                  <Th className="text-right">Failures</Th>
                  <Th className="text-right">p95</Th>
                </tr>
              </thead>
              <tbody>
                {toolUsage.map((row) => (
                  <tr key={row.tool}>
                    <Td>
                      <code className="font-mono text-xs">{row.tool}</code>
                    </Td>
                    <Td className="tabular text-right text-xs">{row.calls}</Td>
                    <Td className="tabular text-right text-xs" style={{ color: row.failures > 0 ? 'var(--danger)' : undefined }}>
                      {row.failures}
                    </Td>
                    <Td className="tabular text-right text-xs">{duration(row.p95DurationMs)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Model usage" subtitle="Calls per model" />
          {byModel.length === 0 ? (
            <EmptyState title="No model calls recorded" body="Run an agent to populate this." />
          ) : (
            <BarList
              items={byModel.map((row) => ({ label: row.model, value: row.calls, display: `${row.calls} calls` }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
