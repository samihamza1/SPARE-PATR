-- migrate:up

-- Price lists, one currency each (a tenant currency). Price tiers come later (BRIEF: Plus).
CREATE TABLE price_lists (
  id          uuid PRIMARY KEY CONSTRAINT price_lists_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  currency    text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT price_lists_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT price_lists_currency_fkey FOREIGN KEY (tenant_id, currency)
    REFERENCES tenant_currencies (tenant_id, code)
);
CREATE UNIQUE INDEX price_lists_name_key ON price_lists (tenant_id, normalize_search(name))
  WHERE archived_at IS NULL;
-- At most one default list per currency.
CREATE UNIQUE INDEX price_lists_default_key ON price_lists (tenant_id, currency)
  WHERE is_default AND archived_at IS NULL;
CREATE TRIGGER price_lists_set_updated_at BEFORE UPDATE ON price_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Price history is append-only (invariant 7): a change is a new row; the current price is
-- the latest row in effect. Amounts are NUMERIC at the list currency's minor units.
CREATE TABLE part_prices (
  id              uuid PRIMARY KEY CONSTRAINT part_prices_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  price_list_id   uuid NOT NULL,
  part_id         uuid NOT NULL,
  price           numeric NOT NULL CHECK (price >= 0),
  effective_at    timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid,
  source          text NOT NULL CHECK (source IN ('manual', 'import')),
  import_batch_id uuid,
  reason          text CHECK (length(reason) <= 500),
  CONSTRAINT part_prices_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT part_prices_list_fkey FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  CONSTRAINT part_prices_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT part_prices_recorded_by_fkey FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX part_prices_current_idx
  ON part_prices (tenant_id, price_list_id, part_id, effective_at DESC, recorded_at DESC);

CREATE FUNCTION check_price_scale() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  units smallint;
BEGIN
  SELECT c.minor_units INTO units
    FROM price_lists l
    JOIN tenant_currencies c ON c.tenant_id = l.tenant_id AND c.code = l.currency
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.price_list_id;
  IF units IS NOT NULL AND scale(NEW.price) > units THEN
    RAISE EXCEPTION 'price % has more decimals than the list currency allows (%)', NEW.price, units
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER part_prices_check_scale BEFORE INSERT ON part_prices
  FOR EACH ROW EXECUTE FUNCTION check_price_scale();
CREATE TRIGGER part_prices_forbid_update_delete BEFORE UPDATE OR DELETE ON part_prices
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER part_prices_forbid_truncate BEFORE TRUNCATE ON part_prices
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON price_lists
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE part_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON part_prices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON price_lists TO autoparts_app;
GRANT UPDATE (name, is_default, archived_at) ON price_lists TO autoparts_app;
GRANT SELECT, INSERT ON part_prices TO autoparts_app;

-- migrate:down

DROP TABLE part_prices;
DROP FUNCTION check_price_scale();
DROP TABLE price_lists;
