import { Badge, Card, EmptyState, ErrorState, Mono, PageHeader, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function SchedulesPage() {
  const result = await load(async () => {
    const c = api();
    const [schedules, agents] = await Promise.all([c.schedules.list({ limit: 100 }), c.agents.list({ limit: 100 })]);
    return { schedules, agents };
  });

  if (result.error) {
    return (
      <>
        <PageHeader title="Schedules" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { schedules, agents } = result.data;
  const agentName = (id: string) => agents.items.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Each firing is claimed with a compare-and-set, so several schedulers cannot double-fire the same slot."
      />
      <Card>
        {schedules.items.length === 0 ? (
          <EmptyState title="No schedules" body="Create one with POST /v1/schedules using a cron expression, an interval, or a one-off timestamp." />
        ) : (
          <Table caption="Schedules">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Agent</Th>
                <Th>When</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {schedules.items.map((schedule) => (
                <tr key={schedule.id}>
                  <Td className="text-sm">{schedule.name}</Td>
                  <Td className="text-sm">{agentName(schedule.agentId)}</Td>
                  <Td>
                    <Mono>{schedule.expression}</Mono>
                    <span className="ml-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                      {schedule.kind} · {schedule.timezone}
                    </span>
                  </Td>
                  <Td className="text-xs" title={absoluteTime(schedule.nextRunAt)}>
                    {schedule.nextRunAt ? relativeTime(schedule.nextRunAt) : '—'}
                  </Td>
                  <Td className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {schedule.lastRunAt ? relativeTime(schedule.lastRunAt) : 'never'}
                  </Td>
                  <Td>{schedule.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
