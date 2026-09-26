import { Badge, Card, CardHeader, EmptyState, ErrorState, Mono, PageHeader } from '@/components/ui';
import { api, load } from '@/lib/api';

export const dynamic = 'force-dynamic';

const EFFECT_TONE = { deny: 'danger', require_approval: 'warn', allow: 'ok' } as const;

export default async function PoliciesPage() {
  const result = await load(() => api().health().then(() => fetchPolicies()));

  async function fetchPolicies() {
    const response = await fetch(`${process.env.AGENTOS_URL ?? 'http://127.0.0.1:8787'}/v1/policies`, {
      headers: { authorization: `Bearer ${process.env.AGENTOS_API_KEY ?? ''}` },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from /v1/policies`);
    return (await response.json()) as Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      scope: string;
      rules: Array<{ id: string; description: string; effect: keyof typeof EFFECT_TONE; priority: number }>;
    }>;
  }

  if (result.error) {
    return (
      <>
        <PageHeader title="Policies" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Policies"
        description="Evaluated after the agent's own permission gate. A policy can only narrow what an agent may do — never widen it."
      />

      {result.data.length === 0 ? (
        <Card>
          <EmptyState title="No policies" body="Agents still run under their own permission allow-lists." />
        </Card>
      ) : (
        <div className="space-y-4">
          {result.data.map((policy) => (
            <Card key={policy.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {policy.name}
                    <Badge tone={policy.enabled ? 'ok' : 'neutral'}>{policy.enabled ? 'enabled' : 'disabled'}</Badge>
                    <Badge>{policy.scope}</Badge>
                  </span>
                }
                subtitle={policy.description}
              />
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {policy.rules.map((rule) => (
                  <li key={rule.id} className="flex items-start gap-3 px-5 py-3">
                    <Badge tone={EFFECT_TONE[rule.effect] ?? 'neutral'}>{rule.effect.replace(/_/g, ' ')}</Badge>
                    <div className="min-w-0">
                      <p className="text-sm">{rule.description}</p>
                      <p className="mt-0.5">
                        <Mono>
                          {rule.id} · priority {rule.priority}
                        </Mono>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
