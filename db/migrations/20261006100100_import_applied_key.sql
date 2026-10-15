-- migrate:up

-- A sheet of a file may fill more than one price list (another price column each time),
-- so the applied-once key includes the target price list (ADR 0016 addendum).
DROP INDEX import_batches_applied_key;
CREATE UNIQUE INDEX import_batches_applied_key
  ON import_batches (
    tenant_id, kind, file_sha256, coalesce(sheet_name, ''), coalesce(mapping->>'priceListId', '')
  )
  WHERE status = 'applied';

-- migrate:down

DROP INDEX import_batches_applied_key;
CREATE UNIQUE INDEX import_batches_applied_key
  ON import_batches (tenant_id, kind, file_sha256, coalesce(sheet_name, ''))
  WHERE status = 'applied';
