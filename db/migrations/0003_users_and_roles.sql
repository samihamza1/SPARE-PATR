-- Users belong to exactly one tenant (ADR 0006). Authentication is a later sprint.
-- No hard deletes: users are deactivated, role assignments are revoked.
CREATE TABLE users (
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  id             uuid        NOT NULL CHECK (is_uuid_v7(id)),
  username       text        NOT NULL CHECK (btrim(username) <> ''),
  display_name   text        NOT NULL CHECK (btrim(display_name) <> ''),
  -- NULL means: use the tenant default locale.
  locale         text        CHECK (is_locale_tag(locale)),
  is_active      boolean     NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (is_active = (deactivated_at IS NULL))
);
CREATE UNIQUE INDEX users_tenant_username_key ON users (tenant_id, lower(username));
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  tenant_id  uuid        NOT NULL REFERENCES tenants (id),
  id         uuid        NOT NULL CHECK (is_uuid_v7(id)),
  code       text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL CHECK (btrim(name) <> ''),
  is_system  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_roles (
  tenant_id  uuid        NOT NULL REFERENCES tenants (id),
  id         uuid        NOT NULL CHECK (is_uuid_v7(id)),
  user_id    uuid        NOT NULL,
  role_id    uuid        NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES users (tenant_id, id),
  CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);
-- At most one active assignment of a role to a user.
CREATE UNIQUE INDEX user_roles_active_key ON user_roles (tenant_id, user_id, role_id)
  WHERE revoked_at IS NULL;
CREATE INDEX user_roles_role_idx ON user_roles (tenant_id, role_id);

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

GRANT SELECT, INSERT, UPDATE ON users, roles, user_roles TO autoparts_app;
