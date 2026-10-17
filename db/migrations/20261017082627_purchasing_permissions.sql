-- migrate:up

-- Purchasing permissions (packages/shared/src/auth/permissions.ts) for existing tenants'
-- system roles, as agreed with the product owner (2026-10-16): supervisors prepare and post
-- purchases, accountants only view them, cashiers get none, and only owners revalue stock.
-- FORCE RLS hides the rows from the owner role, so it is lifted inside this transaction only.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = ARRAY(
     SELECT DISTINCT p FROM unnest(permissions || CASE code
       WHEN 'owner' THEN ARRAY['purchases.view', 'purchases.manage', 'purchases.post',
                               'stock.revalue']
       WHEN 'supervisor' THEN ARRAY['purchases.view', 'purchases.manage', 'purchases.post']
       WHEN 'accountant' THEN ARRAY['purchases.view']
       ELSE ARRAY[]::text[]
     END) AS p
     ORDER BY p)
 WHERE is_system AND code IN ('owner', 'supervisor', 'accountant');
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- migrate:down

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = ARRAY(
     SELECT p FROM unnest(permissions) AS p
      WHERE p NOT IN ('purchases.view', 'purchases.manage', 'purchases.post', 'stock.revalue')
      ORDER BY p)
 WHERE is_system;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
