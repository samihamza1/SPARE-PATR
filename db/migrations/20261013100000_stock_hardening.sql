-- migrate:up

-- Review fixes for the stock ledger (ADR 0020 addendum).
--
-- 1. SECURITY DEFINER functions name pg_temp last. Unnamed, pg_temp is searched first for
--    relations, so a caller with the TEMP privilege could shadow stock_costs and the other
--    tables these functions write with temp tables of its own.
-- 2. A move locks its part and location rows (FOR SHARE) and refuses an archived part
--    (ST005). Archiving takes a conflicting row lock, so an archive and a move into the same
--    part or location are serialised and check_no_stock sees the committed stock.
-- 3. A closed count or opening draft stays closed.

ALTER FUNCTION sync_tenant_directory() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION resolve_tenant_slug(text) SET search_path = pg_catalog, public, pg_temp;

-- Locks the parts (FOR SHARE, refusing archived ones) and then their cost rows, both in a
-- fixed order so two writers never deadlock, and returns the state to compute moves from.
CREATE OR REPLACE FUNCTION lock_stock_costs(p_part_ids uuid[])
  RETURNS TABLE (part_id uuid, quantity integer, value numeric, ref_quantity integer, ref_value numeric)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_archived uuid;
BEGIN
  PERFORM 1 FROM parts p
   WHERE p.tenant_id = current_tenant_id() AND p.id = ANY (p_part_ids)
   ORDER BY p.id
     FOR SHARE;
  SELECT p.id INTO v_archived FROM parts p
   WHERE p.tenant_id = current_tenant_id() AND p.id = ANY (p_part_ids) AND p.archived_at IS NOT NULL
   ORDER BY p.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'part % is archived', v_archived USING ERRCODE = 'ST005';
  END IF;
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

CREATE OR REPLACE FUNCTION stock_moves_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
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

  -- An archived part takes no stock. FOR SHARE makes a concurrent archive of the part wait
  -- for this move, so its own check sees the stock (and this check sees its archive).
  PERFORM 1 FROM parts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.part_id AND archived_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'part % is archived', NEW.part_id USING ERRCODE = 'ST005';
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
    -- Locked like the part, for the same reason.
    PERFORM 1 FROM locations
     WHERE tenant_id = NEW.tenant_id AND id = NEW.location_id AND archived_at IS NULL
       FOR SHARE;
    IF NOT FOUND THEN
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

-- Lines of an opening draft whose part was archived are excluded (ADR 0024 addendum).
ALTER TABLE opening_stock_lines DROP CONSTRAINT opening_stock_lines_exclusion_check;
ALTER TABLE opening_stock_lines ADD CONSTRAINT opening_stock_lines_exclusion_check
  CHECK (exclusion IN ('by_user', 'already_opened', 'archived_part', 'no_quantity'));

CREATE FUNCTION check_document_stays_closed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (TG_TABLE_NAME = 'opening_stock_drafts' AND OLD.status <> 'draft')
     OR (TG_TABLE_NAME = 'stock_counts' AND OLD.status <> 'open') THEN
    RAISE EXCEPTION '% % is closed', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER opening_stock_drafts_stay_closed BEFORE UPDATE ON opening_stock_drafts
  FOR EACH ROW EXECUTE FUNCTION check_document_stays_closed();
CREATE TRIGGER stock_counts_stay_closed BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION check_document_stays_closed();

-- migrate:down

DROP TRIGGER stock_counts_stay_closed ON stock_counts;
DROP TRIGGER opening_stock_drafts_stay_closed ON opening_stock_drafts;
DROP FUNCTION check_document_stays_closed();
ALTER TABLE opening_stock_lines DROP CONSTRAINT opening_stock_lines_exclusion_check;
ALTER TABLE opening_stock_lines ADD CONSTRAINT opening_stock_lines_exclusion_check
  CHECK (exclusion IN ('by_user', 'already_opened', 'no_quantity')) NOT VALID;
CREATE OR REPLACE FUNCTION stock_moves_apply() RETURNS trigger
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

CREATE OR REPLACE FUNCTION lock_stock_costs(p_part_ids uuid[])
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
ALTER FUNCTION resolve_tenant_slug(text) SET search_path = pg_catalog, public;
ALTER FUNCTION sync_tenant_directory() SET search_path = pg_catalog, public;
