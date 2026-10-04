-- migrate:up

-- Currencies a tenant works with. Which currencies, their minor units and any cash rounding
-- increment are tenant configuration; nothing is seeded. The functional currency must
-- always be present and active (checked at commit, so provisioning can insert the tenant
-- and its currency in one transaction).
CREATE TABLE tenant_currencies (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  code           text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  -- ISO 4217 exponents range from 0 to 4.
  minor_units    smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
  -- Smallest cash denomination, if cash rounding applies.
  cash_increment numeric CHECK (cash_increment > 0 AND scale(cash_increment) <= minor_units),
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_currencies_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT tenant_currencies_tenant_code_key UNIQUE (tenant_id, code)
);

CREATE TRIGGER tenant_currencies_set_updated_at
  BEFORE UPDATE ON tenant_currencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION check_functional_currency() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_tenant uuid;
BEGIN
  -- Separate branches: PL/pgSQL resolves NEW.<field> against the actual row type.
  IF TG_TABLE_NAME = 'tenants' THEN
    v_tenant := NEW.id;
  ELSE
    v_tenant := NEW.tenant_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenants t
    JOIN tenant_currencies c ON c.tenant_id = t.id AND c.code = t.functional_currency
    WHERE t.id = v_tenant AND c.is_active
  ) THEN
    RAISE EXCEPTION 'the functional currency of tenant % must be an active tenant currency', v_tenant
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER tenants_functional_currency_active
  AFTER INSERT OR UPDATE OF functional_currency ON tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_functional_currency();
CREATE CONSTRAINT TRIGGER tenant_currencies_functional_active
  AFTER INSERT OR UPDATE ON tenant_currencies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_functional_currency();

ALTER TABLE tenant_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_currencies
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Code and minor units are fixed once created: amounts already recorded depend on them.
GRANT SELECT, INSERT ON tenant_currencies TO autoparts_app;
GRANT UPDATE (cash_increment, is_active, sort_order) ON tenant_currencies TO autoparts_app;

-- migrate:down

DROP TRIGGER tenants_functional_currency_active ON tenants;
DROP TABLE tenant_currencies;
DROP FUNCTION check_functional_currency();
