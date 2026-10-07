-- migrate:up

-- Fitments a supersession copied from the old part onto the new one (ADR 0014 addendum),
-- so removing a wrong supersession can also remove exactly the links it added.
ALTER TABLE fitments ADD COLUMN supersession_id uuid;
ALTER TABLE fitments ADD CONSTRAINT fitments_supersession_fkey
  FOREIGN KEY (tenant_id, supersession_id) REFERENCES supersessions (tenant_id, id);
CREATE INDEX fitments_tenant_supersession_idx ON fitments (tenant_id, supersession_id)
  WHERE supersession_id IS NOT NULL AND removed_at IS NULL;

-- migrate:down

DROP INDEX fitments_tenant_supersession_idx;
ALTER TABLE fitments DROP CONSTRAINT fitments_supersession_fkey;
ALTER TABLE fitments DROP COLUMN supersession_id;
