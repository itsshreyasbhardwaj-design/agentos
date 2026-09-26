import Link from 'next/link';
import { Badge, Card, EmptyState, ErrorState, Mono, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';
import { relativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const result = await load(() => api().agents.list({ limit: 100 }));

  if (result.error) {
    return (
      <>
        <PageHeader title="Agents" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="An agent is a versioned definition: model, instructions, tools, permissions, limits and policies."
      />
      <Card>
        {result.data.items.length === 0 ? (
          <EmptyState
            title="No agents yet"
            body="Create one with POST /v1/agents, or run `pnpm seed` to load the demo agents."
          />
        ) : (
          <Table caption="Agents">
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Model</Th>
                <Th>Tools</Th>
                <Th>Version</Th>
                <Th className="text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((agent) => (
                <tr key={agent.id}>
                  <Td>
                    <Link href={`/agents/${agent.slug}`} className="text-sm font-medium" style={{ color: 'var(--accent)' }}>
                      {agent.name}
                    </Link>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {agent.description || <Mono>{agent.slug}</Mono>}
                    </p>
                  </Td>
                  <Td>
                    <Mono>{agent.draft.model.primary}</Mono>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {(agent.draft.permissions.allowedTools ?? []).slice(0, 3).map((tool) => (
                        <Badge key={tool}>{tool}</Badge>
                      ))}
                      {(agent.draft.permissions.allowedTools ?? []).length > 3 ? (
                        <Badge>+{(agent.draft.permissions.allowedTools ?? []).length - 3}</Badge>
                      ) : null}
                      {(agent.draft.permissions.allowedTools ?? []).length === 0 ? (
                        <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                          none
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    {agent.publishedVersionId ? (
                      <Badge tone="ok">v{agent.latestVersionNumber}</Badge>
                    ) : (
                      <StatusBadge status="draft" />
                    )}
                  </Td>
                  <Td className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                    {relativeTime(agent.updatedAt)}
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
