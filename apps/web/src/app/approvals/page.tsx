import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Mono, PageHeader } from '@/components/ui';
import { api, load } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/format';
import { DecisionForm } from './decision-form';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const result = await load(async () => {
    const c = api();
    const [approvals, agents] = await Promise.all([c.approvals.listPending({ limit: 100 }), c.agents.list({ limit: 100 })]);
    return { approvals, agents };
  });

  if (result.error) {
    return (
      <>
        <PageHeader title="Approvals" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  const { approvals, agents } = result.data;
  const agentName = (id: string) => agents.items.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Actions an agent proposed that the runtime refuses to take without a human decision."
      />

      {approvals.items.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing is waiting"
            body="When an agent proposes a destructive or otherwise gated action, execution pauses here until you decide."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {approvals.items.map((approval) => (
            <Card key={approval.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Mono className="text-sm">{approval.toolCall.name}</Mono>
                    {approval.destructive ? <Badge tone="danger">destructive</Badge> : null}
                    {approval.operations.map((op) => (
                      <Badge key={op}>{op}</Badge>
                    ))}
                  </span>
                }
                subtitle={
                  <>
                    Requested by {agentName(approval.agentId)} ·{' '}
                    <Link href={`/executions/${approval.executionId}`} style={{ color: 'var(--accent)' }}>
                      {approval.executionId.slice(0, 16)}…
                    </Link>{' '}
                    · <span title={absoluteTime(approval.requestedAt)}>{relativeTime(approval.requestedAt)}</span>
                  </>
                }
              />

              <div className="px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  What will happen
                </p>
                <p className="mt-1 text-sm">{approval.impact}</p>

                <p className="mt-4 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  Why it paused
                </p>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {approval.reason}
                  {approval.ruleId ? (
                    <>
                      {' '}
                      <Mono>({approval.ruleId})</Mono>
                    </>
                  ) : null}
                </p>

                <p className="mt-4 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  Arguments the model proposed
                </p>
                <pre
                  className="mt-1 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs"
                  style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}
                >
                  {JSON.stringify(approval.toolCall.arguments, null, 2)}
                </pre>

                {approval.expiresAt ? (
                  <p className="mt-3 text-xs" style={{ color: 'var(--text-faint)' }}>
                    Expires {relativeTime(approval.expiresAt)} — after that the agent is told the request lapsed.
                  </p>
                ) : null}
              </div>

              <DecisionForm approvalId={approval.id} originalArguments={approval.toolCall.arguments} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
