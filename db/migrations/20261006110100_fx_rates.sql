-- migrate:up

-- Exchange rates entered by hand, usually daily (product owner, 2026-10-06; ADR 0018).
-- Stored as the market quotes them: 1 base_currency = rate quote_currency. One side is the
-- tenant's functional currency. Append-only: a correction is a newer row for the same date;
-- the rate in effect for a date is the latest row dated on or before it.
CREATE TABLE fx_rates (
  id             uuid PRIMARY KEY CONSTRAINT fx_rates_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  base_currency  text NOT NULL,
  quote_currency text NOT NULL,
  rate           numeric NOT NULL
                 CHECK (rate > 0 AND scale(rate) <= 10 AND rate < 1000000000000),
  -- Business date in the tenant's time zone.
  rate_date      date NOT NULL,
  note           text CHECK (length(note) <= 500),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid NOT NULL,
  CONSTRAINT fx_rates_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fx_rates_distinct_check CHECK (base_currency <> quote_currency),
  CONSTRAINT fx_rates_base_fkey FOREIGN KEY (tenant_id, base_currency)
    REFERENCES tenant_currencies (tenant_id, code),
  CONSTRAINT fx_rates_quote_fkey FOREIGN KEY (tenant_id, quote_currency)
    REFERENCES tenant_currencies (tenant_id, code),
  CONSTRAINT fx_rates_recorded_by_fkey FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES users (tenant_id, id)
);
CREATE INDEX fx_rates_lookup_idx
  ON fx_rates (tenant_id, base_currency, quote_currency, rate_date DESC, recorded_at DESC);

CREATE FUNCTION check_fx_rate_pair() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenants t
     WHERE t.id = NEW.tenant_id
       AND t.functional_currency IN (NEW.base_currency, NEW.quote_currency)
  ) THEN
    RAISE EXCEPTION 'an exchange rate needs the functional currency on one side'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fx_rates_check_pair BEFORE INSERT ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION check_fx_rate_pair();
CREATE TRIGGER fx_rates_forbid_update_delete BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fx_rates_forbid_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_rates
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON fx_rates TO autoparts_app;

-- migrate:down

DROP TABLE fx_rates;
DROP FUNCTION check_fx_rate_pair();
