-- Append-only audit trail for price changes, discounts, voids, overrides and
-- stock adjustments (CLAUDE.md invariant 7). Corrections are new entries.
CREATE TABLE audit_log (
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  id            uuid        NOT NULL CHECK (is_uuid_v7(id)),
  -- When it happened (may be earlier than recorded_at for offline devices).
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- When the server stored it.
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  -- Dotted action name, e.g. 'price.change'. The catalogue grows with each module.
  action        text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  entity_type   text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  reason        text,
  -- Offline device that produced the event; FK added once devices exist.
  device_id     uuid,
  request_id    text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, occurred_at);
CREATE INDEX audit_log_occurred_idx ON audit_log (tenant_id, occurred_at);
CREATE INDEX audit_log_actor_idx ON audit_log (tenant_id, actor_user_id, occurred_at);

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON audit_log TO autoparts_app;
