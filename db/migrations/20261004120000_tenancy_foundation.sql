-- migrate:up

-- Only migrations (run as the owner) create objects. The app role can use the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO autoparts_app;

-- Tenant context for row-level security, set per transaction with
-- set_config('app.tenant_id', <uuid>, true), i.e. SET LOCAL. NULLIF is required: once a
-- SET LOCAL has ended, a custom setting reads as '' (not NULL) for the rest of the session.
-- An unset tenant yields NULL, so tenant policies match no rows (fail closed).
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Trigger for append-only tables (invariant 3). Applies to every role, owner included.
CREATE FUNCTION forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% on table "%" is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING HINT = 'Record a correcting entry instead.';
END
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- pg_timezone_names is not immutable, so this runs from a trigger rather than a CHECK.
CREATE FUNCTION validate_tenant() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone "%"', NEW.timezone
      USING ERRCODE = 'check_violation', COLUMN = 'timezone';
  END IF;
  RETURN NEW;
END
$$;

-- A tenant is one customer business. Currency, time zone and locale are required
-- configuration with no defaults: nothing money, tax or locale related is hardcoded.
CREATE TABLE tenants (
  id                  uuid PRIMARY KEY,
  slug                text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  functional_currency text NOT NULL CHECK (functional_currency ~ '^[A-Z]{3}$'),
  timezone            text NOT NULL,
  default_locale      text NOT NULL CHECK (default_locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  settings            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);

CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);

CREATE TRIGGER tenants_validate
  BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION validate_tenant();
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- Tenants are provisioned by the owner role; the app can read and update its own tenant.
GRANT SELECT, UPDATE ON tenants TO autoparts_app;

-- migrate:down

DROP TABLE tenants;
DROP FUNCTION validate_tenant();
DROP FUNCTION set_updated_at();
DROP FUNCTION forbid_mutation();
DROP FUNCTION current_tenant_id();
REVOKE USAGE ON SCHEMA public FROM autoparts_app;
GRANT CREATE ON SCHEMA public TO PUBLIC;
