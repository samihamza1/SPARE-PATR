-- migrate:up

-- Authentication state on users. Archived users cannot log in (enforced by the API).
ALTER TABLE users
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN password_changed_at timestamptz,
  -- Supervisor/offline PIN verifier (Argon2). Used from the POS phase on.
  ADD COLUMN pin_hash text;

-- Server-side sessions. The cookie carries <tenant_id>.<id>.<secret>; only a SHA-256 of
-- the 32-byte secret is stored. Idle expiry is computed from last_seen_at and the tenant
-- setting; expires_at is the absolute limit. Sessions are revoked, never deleted.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  user_id        uuid NOT NULL,
  device_id      uuid,
  secret_hash    bytea NOT NULL CHECK (length(secret_hash) = 32),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason ~ '^[a-z][a-z_]*$'),
  ip             inet,
  user_agent     text CHECK (length(user_agent) <= 512),
  CONSTRAINT sessions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sessions_user_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT sessions_revocation_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX sessions_tenant_user_idx ON sessions (tenant_id, user_id, created_at DESC);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON sessions TO autoparts_app;
GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON sessions TO autoparts_app;

-- migrate:down

DROP TABLE sessions;
ALTER TABLE users
  DROP COLUMN pin_hash,
  DROP COLUMN password_changed_at,
  DROP COLUMN last_login_at,
  DROP COLUMN locked_until,
  DROP COLUMN failed_login_count;
