-- migrate:up

-- Catalog (ADR 0014). Every table is tenant-scoped with forced RLS. Links (numbers,
-- fitments, aliases, interchange, supersession) are removed by setting removed_at, never
-- deleted (invariant 7); changes are audited by the API.

CREATE TABLE brands (
  id          uuid PRIMARY KEY CONSTRAINT brands_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- Vehicle maker (genuine parts, e.g. the brand on OEM numbers) or aftermarket brand.
  kind        text NOT NULL CHECK (kind IN ('vehicle_maker', 'aftermarket')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT brands_tenant_id_id_key UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX brands_tenant_name_key ON brands (tenant_id, normalize_search(name))
  WHERE archived_at IS NULL;

CREATE TABLE categories (
  id          uuid PRIMARY KEY CONSTRAINT categories_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  parent_id   uuid,
  name_ar     text CHECK (length(btrim(name_ar)) BETWEEN 1 AND 100),
  name_en     text CHECK (length(btrim(name_en)) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT categories_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT categories_parent_fkey FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CONSTRAINT categories_name_check CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  CONSTRAINT categories_not_own_parent CHECK (parent_id <> id)
);
CREATE INDEX categories_tenant_parent_idx ON categories (tenant_id, parent_id);

CREATE TABLE parts (
  id            uuid PRIMARY KEY CONSTRAINT parts_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  -- Internal stock-keeping code; part numbers are not unique, so they cannot be the key.
  sku           text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name_ar       text CHECK (length(btrim(name_ar)) BETWEEN 1 AND 200),
  name_en       text CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  -- NULL = not graded yet ("needs review"); search ranks ungraded parts last.
  quality_grade text CHECK (quality_grade IN ('oem', 'premium', 'good', 'economy')),
  brand_id      uuid,
  category_id   uuid,
  unit          text NOT NULL DEFAULT 'piece' CHECK (unit ~ '^[a-z][a-z_]{0,19}$'),
  notes         text CHECK (length(notes) <= 2000),
  search_text   text GENERATED ALWAYS AS (
                  normalize_search(coalesce(name_ar, '') || ' ' || coalesce(name_en, '') || ' ' || sku)
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT parts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT parts_name_check CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  CONSTRAINT parts_brand_fkey FOREIGN KEY (tenant_id, brand_id) REFERENCES brands (tenant_id, id),
  CONSTRAINT parts_category_fkey FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);
CREATE UNIQUE INDEX parts_tenant_sku_key ON parts (tenant_id, upper(sku));
CREATE INDEX parts_search_idx ON parts USING gin (tenant_id, search_text gin_trgm_ops);
CREATE INDEX parts_tenant_brand_idx ON parts (tenant_id, brand_id);
CREATE INDEX parts_tenant_category_idx ON parts (tenant_id, category_id);
CREATE INDEX parts_tenant_ungraded_idx ON parts (tenant_id) WHERE quality_grade IS NULL AND archived_at IS NULL;

-- OEM / aftermarket numbers. NOT unique: parts sharing an OEM number are alternatives.
CREATE TABLE part_numbers (
  id          uuid PRIMARY KEY CONSTRAINT part_numbers_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  part_id     uuid NOT NULL,
  number      text NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 60),
  number_norm text GENERATED ALWAYS AS (normalize_part_number(number)) STORED
              CHECK (number_norm <> ''),
  kind        text NOT NULL CHECK (kind IN ('oem', 'aftermarket', 'other')),
  brand_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  CONSTRAINT part_numbers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT part_numbers_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT part_numbers_brand_fkey FOREIGN KEY (tenant_id, brand_id) REFERENCES brands (tenant_id, id)
);
CREATE UNIQUE INDEX part_numbers_active_key ON part_numbers (tenant_id, part_id, number_norm)
  WHERE removed_at IS NULL;
CREATE INDEX part_numbers_lookup_idx ON part_numbers (tenant_id, number_norm text_pattern_ops)
  WHERE removed_at IS NULL;

-- A part fits a vehicle node at any level (a model covers its generations and engines).
CREATE TABLE fitments (
  id         uuid PRIMARY KEY CONSTRAINT fitments_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  part_id    uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id),
  note       text CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT fitments_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fitments_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id)
);
CREATE UNIQUE INDEX fitments_active_key ON fitments (tenant_id, part_id, vehicle_id)
  WHERE removed_at IS NULL;
CREATE INDEX fitments_tenant_vehicle_idx ON fitments (tenant_id, vehicle_id) WHERE removed_at IS NULL;
CREATE TRIGGER fitments_check_vehicle
  BEFORE INSERT OR UPDATE OF vehicle_id ON fitments
  FOR EACH ROW EXECUTE FUNCTION check_visible_vehicle();

-- Words a shop uses for vehicles ("LC", "لاندكروزر") or product groups ("MF" -> batteries).
-- One alias may point at several vehicles ("GXR/PR/LC").
CREATE TABLE vehicle_aliases (
  id          uuid PRIMARY KEY CONSTRAINT vehicle_aliases_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  alias       text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 60),
  alias_norm  text GENERATED ALWAYS AS (normalize_search(alias)) STORED CHECK (alias_norm <> ''),
  target      text NOT NULL CHECK (target IN ('vehicle', 'category', 'ignore')),
  vehicle_id  uuid REFERENCES vehicles (id),
  category_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  CONSTRAINT vehicle_aliases_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT vehicle_aliases_category_fkey FOREIGN KEY (tenant_id, category_id)
    REFERENCES categories (tenant_id, id),
  CONSTRAINT vehicle_aliases_target_fields_check CHECK (
    (target = 'vehicle' AND vehicle_id IS NOT NULL AND category_id IS NULL)
    OR (target = 'category' AND category_id IS NOT NULL AND vehicle_id IS NULL)
    OR (target = 'ignore' AND vehicle_id IS NULL AND category_id IS NULL))
);
CREATE UNIQUE INDEX vehicle_aliases_active_key ON vehicle_aliases (
  tenant_id, alias_norm,
  coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE removed_at IS NULL;
CREATE TRIGGER vehicle_aliases_check_vehicle
  BEFORE INSERT OR UPDATE OF vehicle_id ON vehicle_aliases
  FOR EACH ROW EXECUTE FUNCTION check_visible_vehicle();

-- Explicit interchange: every part in a group can replace every other.
CREATE TABLE interchange_groups (
  id         uuid PRIMARY KEY CONSTRAINT interchange_groups_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  note       text CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interchange_groups_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE interchange_members (
  id         uuid PRIMARY KEY CONSTRAINT interchange_members_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  group_id   uuid NOT NULL,
  part_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT interchange_members_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT interchange_members_group_fkey FOREIGN KEY (tenant_id, group_id)
    REFERENCES interchange_groups (tenant_id, id),
  CONSTRAINT interchange_members_part_fkey FOREIGN KEY (tenant_id, part_id) REFERENCES parts (tenant_id, id)
);
-- A part belongs to at most one active group.
CREATE UNIQUE INDEX interchange_members_part_key ON interchange_members (tenant_id, part_id)
  WHERE removed_at IS NULL;
CREATE INDEX interchange_members_group_idx ON interchange_members (tenant_id, group_id)
  WHERE removed_at IS NULL;

-- Supersession: old part number replaced by a new part (scenario 7). Chains must not loop.
CREATE TABLE supersessions (
  id           uuid PRIMARY KEY CONSTRAINT supersessions_id_v7 CHECK (is_uuid_v7(id)),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  old_part_id  uuid NOT NULL,
  new_part_id  uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  reason       text CHECK (length(reason) <= 500),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CONSTRAINT supersessions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT supersessions_old_fkey FOREIGN KEY (tenant_id, old_part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT supersessions_new_fkey FOREIGN KEY (tenant_id, new_part_id) REFERENCES parts (tenant_id, id),
  CONSTRAINT supersessions_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT supersessions_not_self CHECK (old_part_id <> new_part_id)
);
CREATE UNIQUE INDEX supersessions_old_key ON supersessions (tenant_id, old_part_id) WHERE removed_at IS NULL;
CREATE INDEX supersessions_new_idx ON supersessions (tenant_id, new_part_id) WHERE removed_at IS NULL;

CREATE FUNCTION check_supersession_cycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.removed_at IS NULL AND EXISTS (
    WITH RECURSIVE chain(part_id) AS (
      SELECT NEW.new_part_id
      UNION
      SELECT s.new_part_id FROM supersessions s
        JOIN chain c ON s.old_part_id = c.part_id
       WHERE s.tenant_id = NEW.tenant_id AND s.removed_at IS NULL AND s.id <> NEW.id
    )
    SELECT 1 FROM chain WHERE part_id = NEW.old_part_id
  ) THEN
    RAISE EXCEPTION 'supersession would create a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supersessions_no_cycle
  BEFORE INSERT OR UPDATE ON supersessions
  FOR EACH ROW EXECUTE FUNCTION check_supersession_cycle();

CREATE TRIGGER brands_set_updated_at BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER parts_set_updated_at BEFORE UPDATE ON parts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brands', 'categories', 'parts', 'part_numbers', 'fitments',
                           'vehicle_aliases', 'interchange_groups', 'interchange_members',
                           'supersessions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) '
                   'WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO autoparts_app', t);
  END LOOP;
END
$$;

-- migrate:down

DROP TABLE supersessions;
DROP FUNCTION check_supersession_cycle();
DROP TABLE interchange_members;
DROP TABLE interchange_groups;
DROP TABLE vehicle_aliases;
DROP TABLE fitments;
DROP TABLE part_numbers;
DROP TABLE parts;
DROP TABLE categories;
DROP TABLE brands;
