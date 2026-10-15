-- migrate:up

-- Users belong to exactly one tenant. Authentication itself comes in a later sprint.
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  username      text NOT NULL CHECK (length(username) BETWEEN 1 AND 100),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  email         text,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  -- Target of composite foreign keys, so references can never cross tenants.
  CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX users_tenant_username_key ON users (tenant_id, lower(username));
CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, lower(email))
  WHERE email IS NOT NULL;

-- Permission codes are defined in application code; roles are per tenant.
CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  code        text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  permissions text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT roles_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX roles_tenant_code_key ON roles (tenant_id, code);

-- Grants are revoked by setting revoked_at, never by deleting the row (invariant 7).
CREATE TABLE user_roles (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT user_roles_user_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT user_roles_role_fkey FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (tenant_id, granted_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT user_roles_revoked_by_fkey FOREIGN KEY (tenant_id, revoked_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT user_roles_revocation_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE UNIQUE INDEX user_roles_active_key ON user_roles (tenant_id, user_id, role_id)
  WHERE revoked_at IS NULL;
CREATE INDEX user_roles_tenant_role_idx ON user_roles (tenant_id, role_id);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_roles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: operational data is archived or revoked, never hard-deleted (invariant 7).
GRANT SELECT, INSERT, UPDATE ON users, roles, user_roles TO autoparts_app;

-- migrate:down

DROP TABLE user_roles;
DROP TABLE roles;
DROP TABLE users;
