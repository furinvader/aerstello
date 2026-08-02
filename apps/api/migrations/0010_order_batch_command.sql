ALTER TABLE order_batches
  ADD COLUMN IF NOT EXISTS command jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE order_batches
  ALTER COLUMN command DROP DEFAULT;
