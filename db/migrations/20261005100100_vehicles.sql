-- migrate:up

-- The vehicle hierarchy type > make > model > generation > engine is SHARED (ADR 0013):
--   tenant_id IS NULL  -> curated by the platform operator, visible to every tenant;
--   tenant_id = X      -> a local addition by tenant X, visible to X only.
-- The app role reads global rows plus its own and writes only its own. The owner role
-- (platform operator tooling) curates global rows. Rows are archived, never deleted.
CREATE TABLE vehicles (
  id              uuid PRIMARY KEY CONSTRAINT vehicles_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id       uuid REFERENCES tenants (id),
  parent_id       uuid REFERENCES vehicles (id),
  level           text NOT NULL CHECK (level IN ('type', 'make', 'model', 'generation', 'engine')),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  name_ar         text CHECK (length(btrim(name_ar)) BETWEEN 1 AND 100),
  year_from       smallint CHECK (year_from BETWEEN 1900 AND 2100),
  year_to         smallint CHECK (year_to BETWEEN 1900 AND 2100),
  engine_code     text CHECK (length(btrim(engine_code)) BETWEEN 1 AND 30),
  displacement_cc integer CHECK (displacement_cc > 0),
  fuel            text CHECK (fuel IN ('petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'cng')),
  search_text     text GENERATED ALWAYS AS (
                    normalize_search(name || ' ' || coalesce(name_ar, '') || ' ' || coalesce(engine_code, ''))
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT vehicles_root_check CHECK ((parent_id IS NULL) = (level = 'type')),
  CONSTRAINT vehicles_years_check CHECK (year_to IS NULL OR year_from IS NULL OR year_to >= year_from),
  CONSTRAINT vehicles_years_level_check
    CHECK ((year_from IS NULL AND year_to IS NULL) OR level IN ('generation', 'engine')),
  CONSTRAINT vehicles_engine_level_check
    CHECK ((engine_code IS NULL AND displacement_cc IS NULL AND fuel IS NULL) OR level = 'engine')
);

CREATE INDEX vehicles_parent_idx ON vehicles (parent_id);
CREATE INDEX vehicles_tenant_idx ON vehicles (tenant_id);
CREATE INDEX vehicles_search_idx ON vehicles USING gin (search_text gin_trgm_ops);
-- Sibling names are unique within the same owner (global, or one tenant).
CREATE UNIQUE INDEX vehicles_sibling_name_key ON vehicles (
  coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  normalize_search(name)
) WHERE archived_at IS NULL;

-- Parent must be visible, one level up, and never a local row under a global child.
CREATE FUNCTION validate_vehicle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  levels constant text[] := ARRAY['type', 'make', 'model', 'generation', 'engine'];
  parent record;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT level, tenant_id INTO parent FROM vehicles
   WHERE id = NEW.parent_id AND (tenant_id IS NULL OR tenant_id = NEW.tenant_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent vehicle % is not available', NEW.parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF array_position(levels, parent.level) <> array_position(levels, NEW.level) - 1 THEN
    RAISE EXCEPTION 'a % cannot be placed under a %', NEW.level, parent.level
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER vehicles_validate
  BEFORE INSERT OR UPDATE OF parent_id, level, tenant_id ON vehicles
  FOR EACH ROW EXECUTE FUNCTION validate_vehicle();
CREATE TRIGGER vehicles_set_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenant tables point at vehicles by id only (global rows have no tenant_id), so a trigger
-- checks the referenced row is global or the same tenant's (ADR 0013).
CREATE FUNCTION check_visible_vehicle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vehicles
     WHERE id = NEW.vehicle_id AND (tenant_id IS NULL OR tenant_id = NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'vehicle % is not available to this tenant', NEW.vehicle_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_read ON vehicles FOR SELECT TO autoparts_app
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id());
CREATE POLICY tenant_insert ON vehicles FOR INSERT TO autoparts_app
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_update ON vehicles FOR UPDATE TO autoparts_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- Platform operator tooling (owner role) curates global rows and promotes local ones.
CREATE POLICY platform_curation ON vehicles TO autoparts_owner
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON vehicles TO autoparts_app;
GRANT UPDATE (name, name_ar, year_from, year_to, engine_code, displacement_cc, fuel, archived_at)
  ON vehicles TO autoparts_app;

-- migrate:down

DROP TABLE vehicles;
DROP FUNCTION check_visible_vehicle();
DROP FUNCTION validate_vehicle();
