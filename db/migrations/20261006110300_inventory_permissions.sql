-- migrate:up

-- Inventory permissions (packages/shared/src/auth/permissions.ts) for existing tenants'
-- system roles, as agreed with the product owner (2026-10-06): supervisors adjust,
-- transfer, count, approve counts and review; accountants enter exchange rates; cashiers
-- take part in counts. Owners get everything. FORCE RLS hides the rows from the owner role,
-- so it is lifted inside this transaction only.
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = ARRAY(
     SELECT DISTINCT p FROM unnest(permissions || CASE code
       WHEN 'owner' THEN ARRAY['locations.manage', 'fx.manage', 'stock.adjust', 'stock.transfer',
                               'stock.count', 'stock.approve_count', 'stock.review', 'stock.opening']
       WHEN 'supervisor' THEN ARRAY['stock.adjust', 'stock.transfer', 'stock.count',
                                    'stock.approve_count', 'stock.review']
       WHEN 'accountant' THEN ARRAY['fx.manage']
       WHEN 'cashier' THEN ARRAY['stock.count']
     END) AS p
     ORDER BY p)
 WHERE is_system AND code IN ('owner', 'supervisor', 'accountant', 'cashier');
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- migrate:down

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles
   SET permissions = ARRAY(
     SELECT p FROM unnest(permissions) AS p
      WHERE p NOT IN ('locations.manage', 'fx.manage', 'stock.adjust', 'stock.transfer',
                      'stock.count', 'stock.approve_count', 'stock.review', 'stock.opening')
      ORDER BY p)
 WHERE is_system;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
