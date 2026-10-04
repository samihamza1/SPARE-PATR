-- migrate:up

-- audit_log.device_id was free text; devices now exist, so make it a real reference
-- (composite with tenant_id, like every FK between tenant tables). ALTER TYPE rewrites
-- the table without firing the append-only row triggers.
ALTER TABLE audit_log ALTER COLUMN device_id TYPE uuid USING device_id::uuid;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_device_fkey
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id);
CREATE INDEX audit_log_tenant_device_idx ON audit_log (tenant_id, device_id)
  WHERE device_id IS NOT NULL;

-- migrate:down

DROP INDEX audit_log_tenant_device_idx;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_device_fkey;
ALTER TABLE audit_log ALTER COLUMN device_id TYPE text USING device_id::text;
