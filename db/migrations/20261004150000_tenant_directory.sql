-- migrate:up

-- Login happens before any tenant context exists, and FORCE RLS hides tenants even from
-- the owner. This global table maps a shop code (slug) to its tenant id and nothing else.
-- The app role cannot read it; it can only call resolve_tenant_slug() for one slug at a
-- time, so tenants cannot be enumerated. See docs/adr/0008-tenant-resolution-at-login.md.
CREATE TABLE tenant_directory (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  slug      text NOT NULL UNIQUE,
  archived  boolean NOT NULL
);

-- Kept in sync by trigger. SECURITY DEFINER so it works whichever role changes the tenant.
CREATE FUNCTION sync_tenant_directory() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO tenant_directory (tenant_id, slug, archived)
  VALUES (NEW.id, NEW.slug, NEW.archived_at IS NOT NULL)
  ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug, archived = EXCLUDED.archived;
  RETURN NULL;
END
$$;

CREATE TRIGGER tenants_sync_directory
  AFTER INSERT OR UPDATE OF slug, archived_at ON tenants
  FOR EACH ROW EXECUTE FUNCTION sync_tenant_directory();

-- Returns the id of an active tenant, or NULL. Never reveals archived or unknown slugs apart.
CREATE FUNCTION resolve_tenant_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT tenant_id FROM tenant_directory WHERE slug = lower(p_slug) AND NOT archived $$;

REVOKE ALL ON tenant_directory FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_slug(text) TO autoparts_app;
REVOKE ALL ON FUNCTION sync_tenant_directory() FROM PUBLIC;

-- Backfill. FORCE RLS hides tenants from the owner, so lift it inside this transaction.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
INSERT INTO tenant_directory (tenant_id, slug, archived)
  SELECT id, slug, archived_at IS NOT NULL FROM tenants;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- The app may rename its tenant and edit locale and settings, nothing else. Changing the
-- functional currency or time zone after transactions exist needs a dedicated procedure.
REVOKE UPDATE ON tenants FROM autoparts_app;
GRANT UPDATE (name, default_locale, settings) ON tenants TO autoparts_app;

-- migrate:down

REVOKE UPDATE (name, default_locale, settings) ON tenants FROM autoparts_app;
GRANT UPDATE ON tenants TO autoparts_app;
DROP TRIGGER tenants_sync_directory ON tenants;
DROP FUNCTION resolve_tenant_slug(text);
DROP FUNCTION sync_tenant_directory();
DROP TABLE tenant_directory;
