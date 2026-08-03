ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS status_token_consumed_at timestamptz;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS host_void_mutation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS order_items_host_void_mutation_uq
  ON order_items(host_void_mutation_id)
  WHERE host_void_mutation_id IS NOT NULL;
