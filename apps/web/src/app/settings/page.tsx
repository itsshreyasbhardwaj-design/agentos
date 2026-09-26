import { Card, CardHeader, Mono, PageHeader } from '@/components/ui';
import { api, load } from '@/lib/api';

export const dynamic = 'force-dynamic';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-4 border-t px-5 py-3 text-sm" style={{ borderColor: 'var(--border)' }}>
      <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        {label}
      </dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  const health = await load(() => api().health());

  return (
    <>
      <PageHeader title="Settings" description="How this dashboard is connected to the control plane." />

      <Card>
        <CardHeader title="Connection" />
        <dl>
          <Row label="API URL" value={<Mono>{process.env.AGENTOS_URL ?? 'http://127.0.0.1:8787'}</Mono>} />
          <Row
            label="API key"
            value={
              process.env.AGENTOS_API_KEY ? (
                <Mono>{`${process.env.AGENTOS_API_KEY.slice(0, 12)}…`}</Mono>
              ) : (
                <span style={{ color: 'var(--danger)' }}>not configured</span>
              )
            }
          />
          <Row
            label="Reachable"
            value={
              health.data ? (
                <span style={{ color: 'var(--ok)' }}>yes — store {health.data.store ? 'ok' : 'degraded'}</span>
              ) : (
                <span style={{ color: 'var(--danger)' }}>no — {health.error?.message}</span>
              )
            }
          />
          {health.data ? (
            <Row
              label="Queue depth"
              value={
                <span className="tabular text-xs" style={{ color: 'var(--text-muted)' }}>
                  ready {health.data.queue.ready} · inflight {health.data.queue.inflight} · delayed{' '}
                  {health.data.queue.delayed} · dead {health.data.queue.dead}
                </span>
              }
            />
          ) : null}
        </dl>
      </Card>

      <Card className="mt-4">
        <CardHeader title="Notes" />
        <div className="space-y-2 px-5 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          <p>
            The dashboard reads and writes only through the public REST API using a single API key held on the server.
            The browser never receives a credential; every mutation goes through a server action.
          </p>
          <p>
            Role-based access control is enforced by the API, not here. A key with a <Mono>viewer</Mono> role will see
            the same pages but its writes will be refused with 403.
          </p>
        </div>
      </Card>
    </>
  );
}
