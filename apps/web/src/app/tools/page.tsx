import { Badge, Card, EmptyState, ErrorState, Mono, PageHeader, Table, Td, Th } from '@/components/ui';
import { api, load } from '@/lib/api';

export const dynamic = 'force-dynamic';

const OP_TONE: Record<string, 'neutral' | 'warn' | 'danger' | 'info'> = {
  read: 'neutral',
  network: 'info',
  write: 'warn',
  delete: 'danger',
  exec: 'danger',
};

export default async function ToolsPage() {
  const result = await load(() => api().tools.list());

  if (result.error) {
    return (
      <>
        <PageHeader title="Tools" />
        <ErrorState message={result.error.message} hint={result.error.hint} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Tools"
        description="Every tool the runtime knows about. An agent can only call the subset its permissions allow, and only through the policy gate."
      />
      <Card>
        {result.data.length === 0 ? (
          <EmptyState title="No tools registered" body="Register tools at startup or attach an MCP server." />
        ) : (
          <Table caption="Registered tools">
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Capabilities</Th>
                <Th>Source</Th>
                <Th>Safety</Th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((tool) => (
                <tr key={tool.name}>
                  <Td>
                    <Mono className="text-sm">{tool.name}</Mono>
                    <p className="mt-0.5 max-w-xl text-xs" style={{ color: 'var(--text-muted)' }}>
                      {tool.description}
                    </p>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {tool.operations.map((op) => (
                        <Badge key={op} tone={OP_TONE[op] ?? 'neutral'}>
                          {op}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={tool.source === 'mcp' ? 'info' : 'neutral'}>{tool.source}</Badge>
                  </Td>
                  <Td>
                    {tool.destructive ? (
                      <Badge tone="danger" title="Requires human approval under the baseline policy">
                        destructive
                      </Badge>
                    ) : (
                      <Badge tone="ok">non-destructive</Badge>
                    )}
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
