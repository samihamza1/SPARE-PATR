-- migrate:up

-- New permissions (packages/shared/src/auth/permissions.ts) for existing tenants' system
-- owner role (ADR 0009: adding a permission needs a data migration). FORCE RLS hides the
-- rows from the owner role, so it is lifted inside this transaction only.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = ARRAY(
     SELECT DISTINCT p FROM unnest(permissions || ARRAY['catalog.import', 'catalog.manage', 'prices.manage']) AS p
     ORDER BY p)
 WHERE is_system AND code = 'owner';
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- migrate:down

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = array_remove(array_remove(array_remove(permissions,
         'catalog.import'), 'catalog.manage'), 'prices.manage')
 WHERE is_system AND code = 'owner';
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
