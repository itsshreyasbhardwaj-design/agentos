/**
 * Schema for the SQL store.
 *
 * Shape rules: anything filtered, sorted or joined on is a real column; nested
 * documents that are only ever read as a unit (agent specs, execution state,
 * event payloads) live in JSONB. Every tenant-scoped table carries `org_id` and
 * every lookup index leads with it, so a query that forgets the tenant cannot
 * accidentally use an index and appear correct in testing.
 */
export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  limit_ceiling JSONB
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  draft JSONB NOT NULL,
  published_version_id TEXT,
  latest_version_number INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS agents_org_created_idx ON agents (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  version INT NOT NULL,
  spec JSONB NOT NULL,
  status TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  published_at BIGINT NOT NULL,
  published_by TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  UNIQUE (agent_id, version)
);
CREATE INDEX IF NOT EXISTS agent_versions_org_agent_idx ON agent_versions (org_id, agent_id, version DESC);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  version_number INT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  replay_of_execution_id TEXT,
  parent_execution_id TEXT,
  task_id TEXT,
  trigger JSONB NOT NULL,
  user_id TEXT,
  input JSONB,
  output JSONB,
  error JSONB,
  state JSONB NOT NULL,
  usage JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT,
  lease JSONB,
  lease_expires_at BIGINT,
  attempt INT NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS executions_idempotency_idx
  ON executions (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS executions_org_created_idx ON executions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_org_agent_idx ON executions (org_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_org_status_idx ON executions (org_id, status);
-- Lease recovery scans across tenants, so this index is deliberately global.
CREATE INDEX IF NOT EXISTS executions_lease_idx ON executions (lease_expires_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  execution_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  at BIGINT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_span_id TEXT,
  duration_ms INT,
  payload JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_execution_seq_idx ON events (execution_id, seq) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_org_at_idx ON events (org_id, at DESC);
CREATE INDEX IF NOT EXISTS events_org_type_at_idx ON events (org_id, type, at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_call JSONB NOT NULL,
  reason TEXT NOT NULL,
  rule_id TEXT,
  impact TEXT NOT NULL,
  operations JSONB NOT NULL,
  destructive BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  expires_at BIGINT,
  decided_at BIGINT,
  decided_by TEXT,
  decision_note TEXT,
  edited_arguments JSONB
);
CREATE INDEX IF NOT EXISTS approvals_org_status_idx ON approvals (org_id, status, requested_at);
CREATE INDEX IF NOT EXISTS approvals_execution_idx ON approvals (execution_id);
CREATE INDEX IF NOT EXISTS approvals_expiry_idx ON approvals (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  error JSONB,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  execution_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT,
  created_by TEXT NOT NULL,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  task_id TEXT,
  from_agent_id TEXT NOT NULL,
  from_execution_id TEXT,
  to_agent_id TEXT NOT NULL,
  to_execution_id TEXT,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS agent_messages_inbox_idx ON agent_messages (org_id, to_agent_id, status, created_at);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  input JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_run_at BIGINT,
  next_run_at BIGINT,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  signing_secret_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  tolerance_seconds INT NOT NULL DEFAULT 300,
  rate_limit_per_minute INT NOT NULL DEFAULT 60,
  created_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx ON webhook_endpoints (org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  accepted BOOLEAN NOT NULL,
  rejection_reason TEXT,
  execution_id TEXT,
  UNIQUE (endpoint_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (org_id, endpoint_id, received_at DESC);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope TEXT NOT NULL,
  rules JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS secrets (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  hint TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  last_used_at BIGINT,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_org_at_idx ON audit_log (org_id, at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  response JSONB,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);
`,
  },
];

export const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);
`;
