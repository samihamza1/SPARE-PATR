-- migrate:up

-- Registered terminals (POS tablets, back-office PCs). An admin creates a device and gets a
-- one-time enrollment code; the device exchanges it for a long-lived credential. Only
-- SHA-256 hashes of the code and credential are stored. Devices are revoked, never deleted.
CREATE TABLE devices (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enrollment_code_hash  bytea CHECK (length(enrollment_code_hash) = 32),
  enrollment_expires_at timestamptz,
  credential_hash       bytea CHECK (length(credential_hash) = 32),
  enrolled_at           timestamptz,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_by            uuid,
  CONSTRAINT devices_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT devices_created_by_fkey FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT devices_revoked_by_fkey FOREIGN KEY (tenant_id, revoked_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT devices_enrollment_check CHECK ((enrolled_at IS NULL) = (credential_hash IS NULL)),
  CONSTRAINT devices_code_expiry_check
    CHECK (enrollment_code_hash IS NULL OR enrollment_expires_at IS NOT NULL),
  CONSTRAINT devices_revocation_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE UNIQUE INDEX devices_tenant_name_key ON devices (tenant_id, lower(name))
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX devices_tenant_code_key ON devices (tenant_id, enrollment_code_hash)
  WHERE enrollment_code_hash IS NOT NULL;
CREATE UNIQUE INDEX devices_tenant_credential_key ON devices (tenant_id, credential_hash)
  WHERE credential_hash IS NOT NULL;

CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON devices TO autoparts_app;

ALTER TABLE sessions ADD CONSTRAINT sessions_device_fkey
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id);

-- migrate:down

ALTER TABLE sessions DROP CONSTRAINT sessions_device_fkey;
DROP TABLE devices;
