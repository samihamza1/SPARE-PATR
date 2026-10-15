-- migrate:up

-- Append-only record of sensitive actions: price changes, discounts, voids, overrides and
-- stock adjustments (invariant 7). occurred_at is when it happened (possibly offline, on a
-- device); recorded_at is when the server stored it.
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type   text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  reason        text,
  device_id     text,
  request_id    text,
  CONSTRAINT audit_log_actor_fkey FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users (tenant_id, id)
);

CREATE INDEX audit_log_tenant_occurred_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_tenant_entity_idx ON audit_log (tenant_id, entity_type, entity_id);

CREATE TRIGGER audit_log_forbid_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_forbid_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON audit_log TO autoparts_app;

-- migrate:down

DROP TABLE audit_log;
