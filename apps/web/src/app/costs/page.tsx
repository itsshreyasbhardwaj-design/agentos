import { BarList, Card, CardHeader, EmptyState, ErrorState, PageHeader, Stat } from '@/components/ui';
import { api, load } from '@/lib/api';
import { count, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CostsPage() {
  const result = await load(async () => {
    const c = api();
    const [overview, byAgent, byModel, agents] = await Promise.all([
      c.metrics.overview(),
      c.metrics.costByAgent(),
      c.metrics.costByModel(),
      c.agents.list({ limit: 100 }),
    ]);
    return { overview, byAgent, byModel, agents };
  });

  if (result.error) {
    return (
      <>
        <PageHeader title="Costs" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { overview, byAgent, byModel, agents } = result.data;
  const agentName = (id: string) => agents.items.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Costs"
        description="Estimated from published list prices and recorded token counts — not from a provider invoice."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total" value={usd(overview.costMicroUsd)} hint="last 7 days" />
        <Stat label="Tokens" value={count(overview.totalTokens)} />
        <Stat label="Model calls" value={count(overview.modelCalls)} />
        <Stat
          label="Cost per execution"
          value={overview.executions === 0 ? '—' : usd(Math.round(overview.costMicroUsd / overview.executions))}
          hint={`${overview.executions} executions`}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By agent" />
          {byAgent.length === 0 ? (
            <EmptyState title="No spend recorded" body="Cost accrues as agents make model calls." />
          ) : (
            <BarList
              items={byAgent.map((row) => ({
                label: agentName(row.agentId),
                value: row.costMicroUsd,
                display: `${usd(row.costMicroUsd)} · ${row.executions} runs`,
              }))}
            />
          )}
        </Card>

        <Card>
          <CardHeader title="By model" />
          {byModel.length === 0 ? (
            <EmptyState title="No model calls recorded" body="Run an agent to see per-model spend." />
          ) : (
            <BarList
              items={byModel.map((row) => ({
                label: row.model,
                value: row.costMicroUsd,
                display: `${usd(row.costMicroUsd)} · ${row.calls} calls`,
              }))}
            />
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs" style={{ color: 'var(--text-faint)' }}>
        Locally hosted models are priced at zero. A model with no catalogue entry contributes no cost, so a figure here
        can understate real spend — it is an estimate for control and comparison, not a bill.
      </p>
    </>
  );
}
