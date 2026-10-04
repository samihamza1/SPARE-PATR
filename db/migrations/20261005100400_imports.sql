-- migrate:up

-- Staging for catalog imports (ADR 0016). Only the mapped sheet's rows are stored, never
-- the uploaded file. Quantities and costs stay here for the opening-stock step (Sprint 4);
-- the API shows costs only to users with cost.view.
CREATE TABLE import_batches (
  id          uuid PRIMARY KEY CONSTRAINT import_batches_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  kind        text NOT NULL CHECK (kind IN ('catalog')),
  file_name   text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_sha256 bytea NOT NULL CHECK (length(file_sha256) = 32),
  sheet_name  text CHECK (length(sheet_name) <= 100),
  header_row  integer CHECK (header_row >= 1),
  mapping     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(mapping) = 'object'),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'previewed', 'applied', 'discarded')),
  stats       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stats) = 'object'),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  applied_by  uuid,
  CONSTRAINT import_batches_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT import_batches_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT import_batches_applied_by_fkey FOREIGN KEY (tenant_id, applied_by) REFERENCES users (tenant_id, id),
  CONSTRAINT import_batches_applied_check
    CHECK ((status = 'applied') = (applied_at IS NOT NULL AND applied_by IS NOT NULL))
);
-- The same sheet of the same file is applied at most once (idempotent re-import).
CREATE UNIQUE INDEX import_batches_applied_key
  ON import_batches (tenant_id, kind, file_sha256, coalesce(sheet_name, ''))
  WHERE status = 'applied';
CREATE INDEX import_batches_tenant_created_idx ON import_batches (tenant_id, created_at DESC);
CREATE TRIGGER import_batches_set_updated_at BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_rows (
  id         uuid PRIMARY KEY CONSTRAINT import_rows_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  batch_id   uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number >= 1),
  raw        jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  parsed     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(parsed) = 'object'),
  issues     text[] NOT NULL DEFAULT '{}',
  -- Identity across imports: normalised part number + name + vehicle code.
  row_key    text,
  decision   text CHECK (decision IN ('create', 'update', 'skip')),
  part_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_rows_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT import_rows_batch_fkey FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id),
  CONSTRAINT import_rows_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id)
);
CREATE UNIQUE INDEX import_rows_batch_row_key ON import_rows (tenant_id, batch_id, row_number);
CREATE INDEX import_rows_tenant_key_idx ON import_rows (tenant_id, row_key);
CREATE TRIGGER import_rows_set_updated_at BEFORE UPDATE ON import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE part_prices ADD CONSTRAINT part_prices_import_batch_fkey
  FOREIGN KEY (tenant_id, import_batch_id) REFERENCES import_batches (tenant_id, id);

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batches
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_rows
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON import_batches, import_rows TO autoparts_app;

-- migrate:down

ALTER TABLE part_prices DROP CONSTRAINT part_prices_import_batch_fkey;
DROP TABLE import_rows;
DROP TABLE import_batches;
