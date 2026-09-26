import Link from 'next/link';
import { Card, EmptyState, ErrorState, Mono, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const result = await load(() => api().tasks.list({ limit: 100 }));

  if (result.error) {
    return (
      <>
        <PageHeader title="Tasks" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        description="A task is the unit of intent; an execution is one attempt at it. A task with dependencies stays blocked until they complete."
      />
      <Card>
        {result.data.items.length === 0 ? (
          <EmptyState title="No tasks" body="Create one with POST /v1/tasks, optionally with dependsOn." />
        ) : (
          <Table caption="Tasks">
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>Status</Th>
                <Th>Depends on</Th>
                <Th>Execution</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((task) => (
                <tr key={task.id}>
                  <Td>
                    <span className="text-sm">{task.title}</span>
                    <p className="mt-0.5">
                      <Mono>{task.id}</Mono>
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={task.status} />
                  </Td>
                  <Td className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {task.dependsOn.length === 0 ? '—' : `${task.dependsOn.length} task(s)`}
                  </Td>
                  <Td>
                    {task.executionId ? (
                      <Link href={`/executions/${task.executionId}`} className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                        {task.executionId.slice(0, 14)}…
                      </Link>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                        not started
                      </span>
                    )}
                  </Td>
                  <Td className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                    {relativeTime(task.createdAt)}
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
