-- migrate:up

-- Suppliers (ADR 0026): who the shop buys from. Tenant-local master data that purchase
-- receipts reference. Active suppliers have distinct names, as locations do.
CREATE TABLE suppliers (
  id               uuid PRIMARY KEY CONSTRAINT suppliers_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- Proposed for new invoices from this supplier; each invoice may use another one.
  default_currency text,
  phone            text CHECK (length(phone) <= 40),
  note             text CHECK (length(note) <= 500),
  -- SHA-256 of the create request: a retry with the same id must send the same request
  -- (invariant 5), whatever was edited since.
  request_hash     bytea NOT NULL CHECK (length(request_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT suppliers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT suppliers_currency_fkey FOREIGN KEY (tenant_id, default_currency)
    REFERENCES tenant_currencies (tenant_id, code)
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (tenant_id, normalize_search(name))
  WHERE archived_at IS NULL;
CREATE TRIGGER suppliers_set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A supplier's own part numbers, as printed on its invoices, mapped once to an internal
-- part and remembered (BRIEF scenario 4). Kept apart from part_numbers, which sales search
-- matches. Per supplier, an active number points to exactly one part; a part may have
-- several numbers from the same supplier.
CREATE TABLE supplier_parts (
  id          uuid PRIMARY KEY CONSTRAINT supplier_parts_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  supplier_id uuid NOT NULL,
  part_id     uuid NOT NULL,
  number      text NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 60),
  number_norm text GENERATED ALWAYS AS (normalize_part_number(number)) STORED
              CHECK (number_norm <> ''),
  request_hash bytea NOT NULL CHECK (length(request_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL,
  removed_at  timestamptz,
  removed_by  uuid,
  CONSTRAINT supplier_parts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT supplier_parts_removed_check CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT supplier_parts_supplier_fkey FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES suppliers (tenant_id, id),
  CONSTRAINT supplier_parts_part_fkey FOREIGN KEY (tenant_id, part_id)
    REFERENCES parts (tenant_id, id),
  CONSTRAINT supplier_parts_created_by_fkey FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT supplier_parts_removed_by_fkey FOREIGN KEY (tenant_id, removed_by)
    REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX supplier_parts_active_key ON supplier_parts (tenant_id, supplier_id, number_norm)
  WHERE removed_at IS NULL;
CREATE INDEX supplier_parts_tenant_part_idx ON supplier_parts (tenant_id, part_id)
  WHERE removed_at IS NULL;

-- A removed mapping stays removed; mapping the number again is a new row (history kept).
CREATE FUNCTION check_supplier_part_removal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'supplier part % is already removed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_parts_check_removal BEFORE UPDATE ON supplier_parts
  FOR EACH ROW EXECUTE FUNCTION check_supplier_part_removal();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppliers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE supplier_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_parts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON suppliers TO autoparts_app;
GRANT UPDATE (name, default_currency, phone, note, archived_at) ON suppliers TO autoparts_app;
GRANT SELECT, INSERT ON supplier_parts TO autoparts_app;
GRANT UPDATE (removed_at, removed_by) ON supplier_parts TO autoparts_app;

-- migrate:down

DROP TABLE supplier_parts;
DROP FUNCTION check_supplier_part_removal();
DROP TABLE suppliers;
