-- migrate:up

-- Invariant 5: ids are UUID v7, generated client-side. The API validates the version;
-- this makes the database refuse anything else too. PG16-compatible (no uuid_extract_version).
CREATE FUNCTION is_uuid_v7(value uuid) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT substr(value::text, 15, 1) = '7'
       AND substr(value::text, 20, 1) IN ('8', '9', 'a', 'b')
  $$;

-- NOT VALID + VALIDATE: existing rows are checked without holding a long exclusive lock.
ALTER TABLE tenants ADD CONSTRAINT tenants_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE users ADD CONSTRAINT users_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE roles ADD CONSTRAINT roles_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE sessions ADD CONSTRAINT sessions_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE devices ADD CONSTRAINT devices_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;
ALTER TABLE tenant_currencies ADD CONSTRAINT tenant_currencies_id_v7 CHECK (is_uuid_v7(id)) NOT VALID;

ALTER TABLE tenants VALIDATE CONSTRAINT tenants_id_v7;
ALTER TABLE users VALIDATE CONSTRAINT users_id_v7;
ALTER TABLE roles VALIDATE CONSTRAINT roles_id_v7;
ALTER TABLE user_roles VALIDATE CONSTRAINT user_roles_id_v7;
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_id_v7;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_id_v7;
ALTER TABLE devices VALIDATE CONSTRAINT devices_id_v7;
ALTER TABLE tenant_currencies VALIDATE CONSTRAINT tenant_currencies_id_v7;

-- migrate:down

ALTER TABLE tenant_currencies DROP CONSTRAINT tenant_currencies_id_v7;
ALTER TABLE devices DROP CONSTRAINT devices_id_v7;
ALTER TABLE sessions DROP CONSTRAINT sessions_id_v7;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_id_v7;
ALTER TABLE user_roles DROP CONSTRAINT user_roles_id_v7;
ALTER TABLE roles DROP CONSTRAINT roles_id_v7;
ALTER TABLE users DROP CONSTRAINT users_id_v7;
ALTER TABLE tenants DROP CONSTRAINT tenants_id_v7;
DROP FUNCTION is_uuid_v7(uuid);
