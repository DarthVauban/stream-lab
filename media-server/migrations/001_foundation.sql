CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS state_documents (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx
  ON audit_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_target_idx
  ON audit_log (target_type, target_id, occurred_at DESC);
