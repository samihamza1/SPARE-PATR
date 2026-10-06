-- migrate:up

-- Opening stock is posted once per part and location (ADR 0024).
CREATE UNIQUE INDEX stock_moves_opening_key ON stock_moves (tenant_id, part_id, location_id)
  WHERE kind = 'opening';

-- Opening stock from an applied catalog import (ADR 0024): a draft with one line per part,
-- reviewed and completed by the owner, then posted as one stock document whose id is the
-- draft's id.
CREATE TABLE opening_stock_drafts (
  id            uuid PRIMARY KEY CONSTRAINT opening_stock_drafts_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  batch_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  -- The go-live date in the tenant's time zone.
  as_of         date NOT NULL,
  -- The currency of the file's cost column (from the import mapping).
  cost_currency text NOT NULL,
  -- The go-live day's rate when costs are not in the functional currency.
  fx_rate_id    uuid,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'discarded')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  posted_at     timestamptz,
  posted_by     uuid,
  CONSTRAINT opening_stock_drafts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT opening_stock_drafts_batch_fkey FOREIGN KEY (tenant_id, batch_id)
    REFERENCES import_batches (tenant_id, id),
  CONSTRAINT opening_stock_drafts_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id),
  CONSTRAINT opening_stock_drafts_currency_fkey FOREIGN KEY (tenant_id, cost_currency)
    REFERENCES tenant_currencies (tenant_id, code),
  CONSTRAINT opening_stock_drafts_fx_rate_fkey FOREIGN KEY (tenant_id, fx_rate_id)
    REFERENCES fx_rates (tenant_id, id),
  CONSTRAINT opening_stock_drafts_created_by_fkey FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT opening_stock_drafts_posted_by_fkey FOREIGN KEY (tenant_id, posted_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT opening_stock_drafts_posted_check
    CHECK ((status = 'posted') = (posted_at IS NOT NULL AND posted_by IS NOT NULL))
);
-- One live opening per import batch.
CREATE UNIQUE INDEX opening_stock_drafts_batch_key ON opening_stock_drafts (tenant_id, batch_id)
  WHERE status <> 'discarded';
CREATE TRIGGER opening_stock_drafts_set_updated_at BEFORE UPDATE ON opening_stock_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE opening_stock_lines (
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  draft_id            uuid NOT NULL,
  part_id             uuid NOT NULL,
  -- File rows combined into this line (repeated part numbers: quantities are summed).
  rows                integer NOT NULL CHECK (rows >= 1),
  -- The file's quantities summed as read; quantity is NULL when that is not whole units.
  file_quantity       numeric,
  quantity            integer CHECK (quantity >= 0),
  -- Sum of quantity x unit cost over the rows, exact (not rounded); set when every row
  -- with a quantity had a cost. The weighted average is this divided by file_quantity.
  file_cost_total     numeric CHECK (file_cost_total >= 0),
  -- A unit cost entered by the owner, in the draft's cost currency.
  unit_cost           numeric CHECK (unit_cost >= 0),
  -- Total cost in the draft's cost currency at its minor units, rounded once from the
  -- file total or the entered unit cost; NULL = needs a cost.
  amount              numeric CHECK (amount >= 0),
  cost_source         text CHECK (cost_source IN ('file', 'entered')),
  -- Average unit cost of the part's rows that had a cost, offered when some did not.
  suggested_unit_cost numeric CHECK (suggested_unit_cost >= 0),
  exclusion           text CHECK (exclusion IN ('by_user', 'already_opened', 'no_quantity')),
  status              text GENERATED ALWAYS AS (
                        CASE
                          WHEN exclusion IS NOT NULL THEN 'excluded'
                          WHEN quantity IS NULL OR quantity = 0 THEN 'needs_quantity'
                          WHEN amount IS NULL THEN 'needs_cost'
                          ELSE 'ready'
                        END) STORED,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, draft_id, part_id),
  CONSTRAINT opening_stock_lines_draft_fkey FOREIGN KEY (tenant_id, draft_id)
    REFERENCES opening_stock_drafts (tenant_id, id),
  CONSTRAINT opening_stock_lines_part_fkey FOREIGN KEY (tenant_id, part_id)
    REFERENCES parts (tenant_id, id),
  CONSTRAINT opening_stock_lines_cost_check CHECK (
    (amount IS NULL) = (cost_source IS NULL)
    AND (cost_source IS DISTINCT FROM 'entered' OR unit_cost IS NOT NULL)
    AND (cost_source IS DISTINCT FROM 'file' OR file_cost_total IS NOT NULL))
);
CREATE INDEX opening_stock_lines_status_idx ON opening_stock_lines (tenant_id, draft_id, status);
CREATE TRIGGER opening_stock_lines_set_updated_at BEFORE UPDATE ON opening_stock_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stock counts (ADR 0025): blind counting by counters, approval by a supervisor or the
-- owner. Each line keeps the location's quantity at the moment it was counted, so sales
-- during the count are not taken for differences.
CREATE TABLE stock_counts (
  id          uuid PRIMARY KEY CONSTRAINT stock_counts_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  location_id uuid NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('all', 'category', 'parts')),
  category_id uuid,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'cancelled')),
  note        text CHECK (length(note) <= 500),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid,
  closed_at   timestamptz,
  document_id uuid,
  CONSTRAINT stock_counts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_counts_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id),
  CONSTRAINT stock_counts_category_fkey FOREIGN KEY (tenant_id, category_id)
    REFERENCES categories (tenant_id, id),
  CONSTRAINT stock_counts_created_by_fkey FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT stock_counts_closed_by_fkey FOREIGN KEY (tenant_id, closed_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT stock_counts_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES stock_documents (tenant_id, id),
  CONSTRAINT stock_counts_category_check CHECK ((scope = 'category') = (category_id IS NOT NULL)),
  CONSTRAINT stock_counts_closed_check
    CHECK ((status = 'open') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT stock_counts_document_check CHECK (status = 'approved' OR document_id IS NULL)
);
-- One open count per location, so no part is counted twice at once.
CREATE UNIQUE INDEX stock_counts_open_key ON stock_counts (tenant_id, location_id)
  WHERE status = 'open';
CREATE INDEX stock_counts_tenant_created_idx ON stock_counts (tenant_id, created_at DESC);

CREATE TABLE stock_count_lines (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  count_id   uuid NOT NULL,
  part_id    uuid NOT NULL,
  counted    integer CHECK (counted >= 0),
  expected   integer,
  counted_at timestamptz,
  counted_by uuid,
  PRIMARY KEY (tenant_id, count_id, part_id),
  CONSTRAINT stock_count_lines_count_fkey FOREIGN KEY (tenant_id, count_id)
    REFERENCES stock_counts (tenant_id, id),
  CONSTRAINT stock_count_lines_part_fkey FOREIGN KEY (tenant_id, part_id)
    REFERENCES parts (tenant_id, id),
  CONSTRAINT stock_count_lines_counted_by_fkey FOREIGN KEY (tenant_id, counted_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT stock_count_lines_entry_check CHECK (
    (counted IS NULL) = (expected IS NULL)
    AND (counted IS NULL) = (counted_at IS NULL)
    AND (counted IS NULL) = (counted_by IS NULL))
);

-- Lines change only while their draft or count is open.
CREATE FUNCTION check_document_line_editable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'opening_stock_lines' THEN
    IF EXISTS (SELECT 1 FROM opening_stock_drafts
                WHERE tenant_id = NEW.tenant_id AND id = NEW.draft_id AND status <> 'draft') THEN
      RAISE EXCEPTION 'opening stock % is closed', NEW.draft_id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM stock_counts
                 WHERE tenant_id = NEW.tenant_id AND id = NEW.count_id AND status <> 'open') THEN
    RAISE EXCEPTION 'stock count % is closed', NEW.count_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER opening_stock_lines_check_editable BEFORE INSERT OR UPDATE ON opening_stock_lines
  FOR EACH ROW EXECUTE FUNCTION check_document_line_editable();
CREATE TRIGGER stock_count_lines_check_editable BEFORE INSERT OR UPDATE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION check_document_line_editable();

ALTER TABLE opening_stock_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_stock_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_stock_drafts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE opening_stock_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_stock_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_stock_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_counts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_count_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON opening_stock_drafts, opening_stock_lines, stock_counts, stock_count_lines
  TO autoparts_app;
GRANT UPDATE (location_id, as_of, fx_rate_id, status, posted_at, posted_by)
  ON opening_stock_drafts TO autoparts_app;
GRANT UPDATE (quantity, unit_cost, amount, cost_source, exclusion) ON opening_stock_lines
  TO autoparts_app;
GRANT UPDATE (status, closed_by, closed_at, document_id) ON stock_counts TO autoparts_app;
GRANT UPDATE (counted, expected, counted_at, counted_by) ON stock_count_lines TO autoparts_app;

-- migrate:down

DROP TABLE stock_count_lines;
DROP TABLE stock_counts;
DROP TABLE opening_stock_lines;
DROP TABLE opening_stock_drafts;
DROP FUNCTION check_document_line_editable();
DROP INDEX stock_moves_opening_key;
