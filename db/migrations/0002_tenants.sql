-- Tenants (one per shop business). Currency, timezone and locale are per-tenant
-- configuration and have no defaults on purpose.
CREATE TABLE tenants (
  id                  uuid        PRIMARY KEY CHECK (is_uuid_v7(id)),
  name                text        NOT NULL CHECK (btrim(name) <> ''),
  slug                text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- IANA name, used for business-day cutoffs. Validated by trigger below.
  timezone            text        NOT NULL,
  -- ISO 4217 code of the functional (book-keeping) currency.
  functional_currency text        NOT NULL CHECK (functional_currency ~ '^[A-Z]{3}$'),
  default_locale      text        NOT NULL CHECK (is_locale_tag(default_locale)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION validate_tenant() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
      RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER tenants_validate BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION validate_tenant();
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The tenants row is visible only inside its own tenant context. Provisioning a
-- tenant is an administrative action run as the owner with app.tenant_id set to
-- the new tenant id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- Currency and timezone are not editable from the app: changing them after
-- transactions exist needs a dedicated, audited procedure.
GRANT SELECT ON tenants TO autoparts_app;
GRANT UPDATE (name, default_locale) ON tenants TO autoparts_app;
