-- migrate:up

-- UUID v7 generated in SQL, for rows the database itself creates (data migrations, review
-- items opened by triggers). PG16-compatible: uuidv7() only exists from PostgreSQL 18.
-- A v4 UUID with its first 48 bits replaced by the Unix time in milliseconds and the
-- version nibble set to 7 (the v4 variant bits already match).
CREATE FUNCTION new_uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE
  AS $$
    SELECT encode(
      set_bit(set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1), 53, 1),
      'hex')::uuid
  $$;

-- Where stock is kept (ADR 0017): shops sell, warehouses (storerooms, depots) only hold
-- stock. Each tenant has exactly one default location, an active shop.
CREATE TABLE locations (
  id          uuid PRIMARY KEY CONSTRAINT locations_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind        text NOT NULL CHECK (kind IN ('shop', 'warehouse')),
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT locations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT locations_default_check
    CHECK (NOT is_default OR (kind = 'shop' AND archived_at IS NULL))
);
CREATE UNIQUE INDEX locations_name_key ON locations (tenant_id, normalize_search(name))
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX locations_default_key ON locations (tenant_id) WHERE is_default;
CREATE TRIGGER locations_set_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Checked at commit, so the default can move from one shop to another in one transaction.
CREATE FUNCTION check_default_location() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM locations WHERE tenant_id = NEW.tenant_id AND archived_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM locations WHERE tenant_id = NEW.tenant_id AND is_default) THEN
    RAISE EXCEPTION 'tenant % needs a default shop', NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER locations_need_default
  AFTER INSERT OR UPDATE ON locations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_default_location();

-- A selling device belongs to an active shop.
ALTER TABLE devices ADD COLUMN location_id uuid;
ALTER TABLE devices ADD CONSTRAINT devices_location_fkey
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id);
CREATE INDEX devices_tenant_location_idx ON devices (tenant_id, location_id);

CREATE FUNCTION check_device_location() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM locations
     WHERE tenant_id = NEW.tenant_id AND id = NEW.location_id
       AND kind = 'shop' AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a device belongs to an active shop' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER devices_check_location BEFORE INSERT OR UPDATE OF location_id ON devices
  FOR EACH ROW EXECUTE FUNCTION check_device_location();

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON locations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Existing tenants get one default shop, and their devices are placed in it. FORCE RLS
-- would hide the rows from the owner role, so it is lifted inside this transaction only.
-- The name is a placeholder the owner renames in Settings; new tenants name it at
-- provisioning.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE devices NO FORCE ROW LEVEL SECURITY;
INSERT INTO locations (id, tenant_id, name, kind, is_default)
SELECT new_uuid_v7(), t.id, 'Main shop', 'shop', true FROM tenants t;
UPDATE devices d
   SET location_id = l.id
  FROM locations l
 WHERE l.tenant_id = d.tenant_id AND l.is_default;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;

-- kind is fixed once created (devices and stock rules depend on it).
GRANT SELECT, INSERT ON locations TO autoparts_app;
GRANT UPDATE (name, is_default, sort_order, archived_at) ON locations TO autoparts_app;
GRANT UPDATE (location_id) ON devices TO autoparts_app;

-- migrate:down

REVOKE UPDATE (location_id) ON devices FROM autoparts_app;
DROP TRIGGER devices_check_location ON devices;
DROP FUNCTION check_device_location();
ALTER TABLE devices DROP COLUMN location_id;
DROP TABLE locations;
DROP FUNCTION check_default_location();
DROP FUNCTION new_uuid_v7();
