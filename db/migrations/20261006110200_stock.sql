-- migrate:up

-- Stock ledger (ADR 0020, costing in ADR 0021).
--
-- stock_moves is the only record of stock and is append-only (invariant 3). Two tables are
-- derived from it inside the database and nothing else writes them:
--   stock_balances  quantity per part and location;
--   stock_costs     quantity and value per part across all locations (AVCO: one average
--                   per part, product owner 2026-10-06), in the functional currency.
-- The API locks the parts' cost rows (lock_stock_costs), computes each move from that state
-- and inserts it with the state it was computed from. The trigger refuses the move if the
-- state changed meanwhile (40001), so two devices can never both take the last unit online.

-- Every move belongs to a posted document. The client chooses the id (invariant 5); a retry
-- with the same id must carry the same request, recorded as its SHA-256.
CREATE TABLE stock_documents (
  id           uuid PRIMARY KEY CONSTRAINT stock_documents_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  kind         text NOT NULL
               CHECK (kind IN ('opening', 'adjustment', 'transfer', 'part_transfer', 'count')),
  request_hash bytea NOT NULL CHECK (length(request_hash) = 32),
  note         text CHECK (length(note) <= 500),
  occurred_at  timestamptz NOT NULL,
  -- Offline documents come from a device and may take stock below zero (with review).
  origin       text NOT NULL CHECK (origin IN ('online', 'offline')),
  device_id    uuid,
  posted_at    timestamptz NOT NULL DEFAULT now(),
  posted_by    uuid NOT NULL,
  CONSTRAINT stock_documents_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_documents_device_fkey FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices (tenant_id, id),
  CONSTRAINT stock_documents_posted_by_fkey FOREIGN KEY (tenant_id, posted_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT stock_documents_offline_check CHECK (origin = 'online' OR device_id IS NOT NULL)
);
CREATE INDEX stock_documents_tenant_posted_idx ON stock_documents (tenant_id, posted_at DESC);

CREATE TABLE stock_moves (
  id                     uuid PRIMARY KEY CONSTRAINT stock_moves_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  -- The order in which the server applied the moves; AVCO follows it (ADR 0021).
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  document_id            uuid NOT NULL,
  line_no                integer NOT NULL CHECK (line_no >= 0),
  part_id                uuid NOT NULL,
  -- NULL only for a cost adjustment, which changes the part's value, not any location.
  location_id            uuid,
  kind                   text NOT NULL,
  reason                 text CHECK (reason IN ('damaged', 'lost', 'found', 'data_correction')),
  -- Whole units (product owner, 2026-10-06); negative takes stock out.
  quantity               integer NOT NULL,
  -- Invariant 2: the value as entered, its currency, the rate used exactly as quoted
  -- (1 fx_base = fx_rate fx_quote, ADR 0019) and the value in the functional currency.
  amount                 numeric NOT NULL,
  currency               text NOT NULL,
  fx_rate                numeric NOT NULL,
  fx_base                text NOT NULL,
  fx_quote               text NOT NULL,
  fx_rate_id             uuid,
  functional_amount      numeric NOT NULL,
  -- False when stock was issued while its cost was unknown (opens a review item).
  cost_known             boolean NOT NULL DEFAULT true,
  -- The state the move was computed from.
  prev_part_quantity     integer NOT NULL,
  prev_part_value        numeric NOT NULL,
  prev_location_quantity integer,
  occurred_at            timestamptz NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_moves_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_moves_document_line_key UNIQUE (tenant_id, document_id, line_no),
  CONSTRAINT stock_moves_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES stock_documents (tenant_id, id),
  CONSTRAINT stock_moves_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT stock_moves_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id),
  CONSTRAINT stock_moves_currency_fkey FOREIGN KEY (tenant_id, currency)
    REFERENCES tenant_currencies (tenant_id, code),
  CONSTRAINT stock_moves_fx_rate_fkey FOREIGN KEY (tenant_id, fx_rate_id)
    REFERENCES fx_rates (tenant_id, id),
  CONSTRAINT stock_moves_kind_check CHECK (
    CASE kind
      WHEN 'opening' THEN quantity > 0 AND reason IS NULL
      WHEN 'adjustment' THEN CASE reason
        WHEN 'damaged' THEN quantity < 0
        WHEN 'lost' THEN quantity < 0
        WHEN 'found' THEN quantity > 0
        WHEN 'data_correction' THEN quantity <> 0
        ELSE false
      END
      WHEN 'count' THEN quantity <> 0 AND reason IS NULL
      WHEN 'transfer_out' THEN quantity < 0 AND reason IS NULL
      WHEN 'transfer_in' THEN quantity > 0 AND reason IS NULL
      WHEN 'part_transfer_out' THEN quantity < 0 AND reason IS NULL
      WHEN 'part_transfer_in' THEN quantity > 0 AND reason IS NULL
      WHEN 'cost_adjustment' THEN quantity = 0 AND reason IS NULL
      ELSE false
    END),
  CONSTRAINT stock_moves_location_check CHECK (
    (kind = 'cost_adjustment') = (location_id IS NULL)
    AND (location_id IS NULL) = (prev_location_quantity IS NULL)),
  CONSTRAINT stock_moves_value_sign_check CHECK (
    (quantity > 0 AND amount >= 0 AND functional_amount >= 0)
    OR (quantity < 0 AND amount <= 0 AND functional_amount <= 0)
    OR (quantity = 0 AND functional_amount <> 0 AND sign(amount) = sign(functional_amount))),
  CONSTRAINT stock_moves_fx_check CHECK (
    fx_rate > 0 AND currency IN (fx_base, fx_quote)
    AND ((fx_base = fx_quote) = (fx_rate_id IS NULL))
    AND (fx_base <> fx_quote OR (fx_rate = 1 AND amount = functional_amount)))
);
CREATE INDEX stock_moves_part_idx ON stock_moves (tenant_id, part_id, seq DESC);
CREATE INDEX stock_moves_location_idx ON stock_moves (tenant_id, location_id, seq DESC);
CREATE INDEX stock_moves_document_idx ON stock_moves (tenant_id, document_id);

CREATE TABLE stock_balances (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  part_id     uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity    integer NOT NULL DEFAULT 0,
  -- For dead-stock review (BRIEF scenario 9).
  last_in_at  timestamptz,
  last_out_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, part_id, location_id),
  CONSTRAINT stock_balances_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT stock_balances_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id)
);
CREATE INDEX stock_balances_location_idx ON stock_balances (tenant_id, location_id, part_id);

CREATE TABLE stock_costs (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  part_id      uuid NOT NULL,
  quantity     integer NOT NULL DEFAULT 0,
  value        numeric NOT NULL DEFAULT 0,
  -- The latest known unit cost as a ratio (ADR 0021); it prices units issued beyond stock.
  ref_quantity integer,
  ref_value    numeric,
  last_move_id uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, part_id),
  CONSTRAINT stock_costs_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT stock_costs_sign_check CHECK (
    (quantity = 0 AND value = 0) OR (quantity > 0 AND value >= 0) OR (quantity < 0 AND value <= 0)),
  CONSTRAINT stock_costs_ref_check CHECK (
    (ref_quantity IS NULL) = (ref_value IS NULL)
    AND (ref_quantity IS NULL OR (ref_quantity > 0 AND ref_value >= 0)))
);

-- Needs review (CLAUDE.md): stock taken below zero, or issued with no known cost.
CREATE TABLE stock_review_items (
  id                     uuid PRIMARY KEY CONSTRAINT stock_review_items_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  kind                   text NOT NULL CHECK (kind IN ('negative_stock', 'cost_unknown')),
  part_id                uuid NOT NULL,
  location_id            uuid,
  move_id                uuid NOT NULL,
  opened_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolved_by            uuid,
  resolution_note        text CHECK (length(btrim(resolution_note)) BETWEEN 1 AND 500),
  resolution_document_id uuid,
  CONSTRAINT stock_review_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_review_items_part_fkey FOREIGN KEY (tenant_id, part_id)
    REFERENCES parts (tenant_id, id),
  CONSTRAINT stock_review_items_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES locations (tenant_id, id),
  CONSTRAINT stock_review_items_move_fkey FOREIGN KEY (tenant_id, move_id)
    REFERENCES stock_moves (tenant_id, id),
  CONSTRAINT stock_review_items_resolved_by_fkey FOREIGN KEY (tenant_id, resolved_by)
    REFERENCES users (tenant_id, id),
  CONSTRAINT stock_review_items_document_fkey FOREIGN KEY (tenant_id, resolution_document_id)
    REFERENCES stock_documents (tenant_id, id),
  CONSTRAINT stock_review_items_resolution_check CHECK (
    (resolved_at IS NULL) = (resolved_by IS NULL)
    AND (resolved_at IS NULL) = (resolution_note IS NULL)
    AND (resolved_at IS NOT NULL OR resolution_document_id IS NULL))
);
CREATE INDEX stock_review_items_open_idx ON stock_review_items (tenant_id, opened_at)
  WHERE resolved_at IS NULL;
CREATE INDEX stock_review_items_part_idx ON stock_review_items (tenant_id, part_id);

-- Postings waiting for the ledger sprint (product owner, 2026-10-06): every document with a
-- value queues one event with the functional amounts the ledger will need.
CREATE TABLE ledger_queue (
  id          uuid PRIMARY KEY CONSTRAINT ledger_queue_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  document_id uuid NOT NULL,
  event       text NOT NULL CHECK (event ~ '^[a-z_]+\.[a-z_]+$'),
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_queue_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT ledger_queue_event_key UNIQUE (tenant_id, document_id, event),
  CONSTRAINT ledger_queue_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES stock_documents (tenant_id, id)
);

-- --- functions -------------------------------------------------------------------------

-- Creates missing cost rows and locks the parts' cost rows in a fixed order (so two
-- writers never deadlock), returning the state to compute moves from.
CREATE FUNCTION lock_stock_costs(p_part_ids uuid[])
  RETURNS TABLE (part_id uuid, quantity integer, value numeric, ref_quantity integer, ref_value numeric)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  INSERT INTO stock_costs (tenant_id, part_id)
  SELECT current_tenant_id(), p FROM unnest(p_part_ids) AS p ORDER BY p
  ON CONFLICT DO NOTHING;
  RETURN QUERY
    SELECT s.part_id, s.quantity, s.value, s.ref_quantity, s.ref_value
      FROM stock_costs s
     WHERE s.tenant_id = current_tenant_id() AND s.part_id = ANY (p_part_ids)
     ORDER BY s.part_id
       FOR UPDATE;
END
$$;

-- Applies each move to the derived tables after checking it. Runs as the owner because the
-- app role may only read stock_balances and stock_costs; RLS still applies (FORCE).
CREATE FUNCTION stock_moves_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_functional text;
  v_settings   jsonb;
  v_units      smallint;
  v_origin     text;
  v_cost       stock_costs%ROWTYPE;
  v_rate       fx_rates%ROWTYPE;
  v_balance    integer;
  v_quantity   integer;
  v_value      numeric;
BEGIN
  SELECT functional_currency, settings INTO v_functional, v_settings
    FROM tenants WHERE id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock moves need the tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Invariant 2: amounts at their currencies' minor units, and the rate used is a recorded one.
  SELECT minor_units INTO v_units FROM tenant_currencies
   WHERE tenant_id = NEW.tenant_id AND code = v_functional;
  IF scale(NEW.functional_amount) > v_units OR scale(NEW.prev_part_value) > v_units THEN
    RAISE EXCEPTION 'functional amount % has more decimals than % allows', NEW.functional_amount, v_functional
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT minor_units INTO v_units FROM tenant_currencies
   WHERE tenant_id = NEW.tenant_id AND code = NEW.currency;
  IF scale(NEW.amount) > v_units THEN
    RAISE EXCEPTION 'amount % has more decimals than % allows', NEW.amount, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.fx_rate_id IS NULL THEN
    IF NEW.currency <> v_functional THEN
      RAISE EXCEPTION 'an amount in % needs a recorded exchange rate', NEW.currency
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_rate FROM fx_rates WHERE tenant_id = NEW.tenant_id AND id = NEW.fx_rate_id;
    IF v_rate.base_currency <> NEW.fx_base OR v_rate.quote_currency <> NEW.fx_quote
       OR v_rate.rate <> NEW.fx_rate OR NEW.currency = v_functional THEN
      RAISE EXCEPTION 'the move does not use exchange rate % as recorded', NEW.fx_rate_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT origin INTO v_origin FROM stock_documents
   WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;

  -- The part's cost state must be the one the move was computed from.
  SELECT * INTO v_cost FROM stock_costs
   WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id
     FOR UPDATE;
  IF NOT FOUND OR v_cost.quantity <> NEW.prev_part_quantity OR v_cost.value <> NEW.prev_part_value THEN
    RAISE EXCEPTION 'stock of part % changed since it was read', NEW.part_id
      USING ERRCODE = 'serialization_failure';
  END IF;
  v_quantity := v_cost.quantity + NEW.quantity;
  v_value := v_cost.value + NEW.functional_amount;
  UPDATE stock_costs
     SET quantity     = v_quantity,
         value        = v_value,
         -- The latest known unit cost (ADR 0021): a positive position, else a receipt's own.
         ref_quantity = CASE WHEN v_quantity > 0 THEN v_quantity
                             WHEN NEW.quantity > 0 THEN NEW.quantity
                             ELSE ref_quantity END,
         ref_value    = CASE WHEN v_quantity > 0 THEN v_value
                             WHEN NEW.quantity > 0 THEN NEW.functional_amount
                             ELSE ref_value END,
         last_move_id = NEW.id,
         updated_at   = now()
   WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id;

  IF NEW.location_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM locations
                    WHERE tenant_id = NEW.tenant_id AND id = NEW.location_id AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'location % is archived', NEW.location_id USING ERRCODE = 'ST002';
    END IF;
    INSERT INTO stock_balances (tenant_id, part_id, location_id)
    VALUES (NEW.tenant_id, NEW.part_id, NEW.location_id)
    ON CONFLICT DO NOTHING;
    SELECT quantity INTO v_balance FROM stock_balances
     WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id AND location_id = NEW.location_id
       FOR UPDATE;
    IF v_balance <> NEW.prev_location_quantity THEN
      RAISE EXCEPTION 'stock of part % at location % changed since it was read', NEW.part_id, NEW.location_id
        USING ERRCODE = 'serialization_failure';
    END IF;
    IF NEW.quantity < 0 AND v_balance + NEW.quantity < 0 THEN
      -- Online: the tenant's setting decides. Offline sales are always accepted (CLAUDE.md).
      IF v_origin = 'online'
         AND NOT coalesce((v_settings #>> '{inventory,allowNegativeStock}')::boolean, false) THEN
        RAISE EXCEPTION 'not enough stock of part % at location %', NEW.part_id, NEW.location_id
          USING ERRCODE = 'ST001';
      END IF;
      INSERT INTO stock_review_items (id, tenant_id, kind, part_id, location_id, move_id)
      VALUES (new_uuid_v7(), NEW.tenant_id, 'negative_stock', NEW.part_id, NEW.location_id, NEW.id);
    END IF;
    UPDATE stock_balances
       SET quantity    = v_balance + NEW.quantity,
           last_in_at  = CASE WHEN NEW.quantity > 0
                              THEN greatest(last_in_at, NEW.occurred_at) ELSE last_in_at END,
           last_out_at = CASE WHEN NEW.quantity < 0
                              THEN greatest(last_out_at, NEW.occurred_at) ELSE last_out_at END,
           updated_at  = now()
     WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id AND location_id = NEW.location_id;
  END IF;

  IF NOT NEW.cost_known THEN
    INSERT INTO stock_review_items (id, tenant_id, kind, part_id, location_id, move_id)
    VALUES (new_uuid_v7(), NEW.tenant_id, 'cost_unknown', NEW.part_id, NEW.location_id, NEW.id);
  END IF;
  RETURN NULL;
END
$$;
-- AFTER, so review items can reference the move. Rows of one INSERT apply in order.
CREATE TRIGGER stock_moves_apply AFTER INSERT ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION stock_moves_apply();
CREATE TRIGGER stock_moves_forbid_update_delete BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_moves_forbid_truncate BEFORE TRUNCATE ON stock_moves
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_documents_forbid_update_delete BEFORE UPDATE OR DELETE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_documents_forbid_truncate BEFORE TRUNCATE ON stock_documents
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_queue_forbid_update_delete BEFORE UPDATE OR DELETE ON ledger_queue
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_queue_forbid_truncate BEFORE TRUNCATE ON ledger_queue
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A review item is resolved once, and only when the problem is gone: the location is no
-- longer below zero, or the part's cost became known.
CREATE FUNCTION check_stock_review_resolution() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'review item % is already resolved', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.kind = 'negative_stock' AND EXISTS (
    SELECT 1 FROM stock_balances
     WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id AND location_id = NEW.location_id
       AND quantity < 0
  ) THEN
    RAISE EXCEPTION 'part % is still below zero at location %', NEW.part_id, NEW.location_id
      USING ERRCODE = 'ST004';
  END IF;
  IF NEW.kind = 'cost_unknown' AND NOT EXISTS (
    SELECT 1 FROM stock_costs
     WHERE tenant_id = NEW.tenant_id AND part_id = NEW.part_id AND ref_quantity IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'part % has no known cost yet', NEW.part_id USING ERRCODE = 'ST004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_review_items_check_resolution BEFORE UPDATE ON stock_review_items
  FOR EACH ROW EXECUTE FUNCTION check_stock_review_resolution();
CREATE TRIGGER stock_review_items_forbid_delete BEFORE DELETE ON stock_review_items
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- --- guards on existing tables -----------------------------------------------------------

-- A part or location that holds stock (anywhere, either sign) cannot be archived, and a
-- part's unit cannot change under its stock.
CREATE FUNCTION check_no_stock() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'parts' THEN
    IF ((NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL) OR NEW.unit <> OLD.unit)
       AND EXISTS (SELECT 1 FROM stock_balances
                    WHERE tenant_id = NEW.tenant_id AND part_id = NEW.id AND quantity <> 0) THEN
      RAISE EXCEPTION 'part % has stock', NEW.id USING ERRCODE = 'ST003';
    END IF;
  ELSIF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM stock_balances
                WHERE tenant_id = NEW.tenant_id AND location_id = NEW.id AND quantity <> 0) THEN
      RAISE EXCEPTION 'location % has stock', NEW.id USING ERRCODE = 'ST003';
    END IF;
    IF EXISTS (SELECT 1 FROM devices
                WHERE tenant_id = NEW.tenant_id AND location_id = NEW.id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'location % has devices', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER parts_check_no_stock BEFORE UPDATE OF archived_at, unit ON parts
  FOR EACH ROW EXECUTE FUNCTION check_no_stock();
CREATE TRIGGER locations_check_no_stock BEFORE UPDATE OF archived_at ON locations
  FOR EACH ROW EXECUTE FUNCTION check_no_stock();

-- Opening stock reads quantities and costs from applied import batches, so their rows are
-- frozen once the batch is applied (or discarded).
CREATE FUNCTION check_import_row_editable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM import_batches
              WHERE tenant_id = OLD.tenant_id AND id = OLD.batch_id
                AND status IN ('applied', 'discarded')) THEN
    RAISE EXCEPTION 'rows of import batch % can no longer change', OLD.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_rows_check_editable BEFORE UPDATE ON import_rows
  FOR EACH ROW EXECUTE FUNCTION check_import_row_editable();

-- Values are kept in the functional currency, so it cannot change once stock or rates exist.
CREATE FUNCTION check_functional_currency_fixed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.functional_currency <> OLD.functional_currency
     AND (EXISTS (SELECT 1 FROM stock_moves WHERE tenant_id = NEW.id)
          OR EXISTS (SELECT 1 FROM fx_rates WHERE tenant_id = NEW.id)) THEN
    RAISE EXCEPTION 'the functional currency of tenant % is in use', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenants_functional_currency_fixed BEFORE UPDATE OF functional_currency ON tenants
  FOR EACH ROW EXECUTE FUNCTION check_functional_currency_fixed();

-- --- isolation and grants -----------------------------------------------------------------

ALTER TABLE stock_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_documents
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_moves
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_balances
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_costs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE stock_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_review_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE ledger_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_queue
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Invariant 3: no UPDATE or DELETE on stock_moves; the derived tables are read-only.
GRANT SELECT, INSERT ON stock_documents, stock_moves, ledger_queue TO autoparts_app;
GRANT SELECT ON stock_balances, stock_costs, stock_review_items TO autoparts_app;
GRANT UPDATE (resolved_at, resolved_by, resolution_note, resolution_document_id)
  ON stock_review_items TO autoparts_app;
REVOKE ALL ON FUNCTION lock_stock_costs(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_stock_costs(uuid[]) TO autoparts_app;
REVOKE ALL ON FUNCTION stock_moves_apply() FROM PUBLIC;

-- migrate:down

DROP TRIGGER tenants_functional_currency_fixed ON tenants;
DROP FUNCTION check_functional_currency_fixed();
DROP TRIGGER import_rows_check_editable ON import_rows;
DROP FUNCTION check_import_row_editable();
DROP TRIGGER locations_check_no_stock ON locations;
DROP TRIGGER parts_check_no_stock ON parts;
DROP FUNCTION check_no_stock();
DROP TABLE ledger_queue;
DROP TABLE stock_review_items;
DROP FUNCTION check_stock_review_resolution();
DROP TABLE stock_costs;
DROP TABLE stock_balances;
DROP TABLE stock_moves;
DROP FUNCTION stock_moves_apply();
DROP FUNCTION lock_stock_costs(uuid[]);
DROP TABLE stock_documents;
