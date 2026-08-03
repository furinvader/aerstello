ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS guest_expected_price_cents integer;

ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS denial_mutation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS access_requests_denial_mutation_uq
  ON access_requests(denial_mutation_id)
  WHERE denial_mutation_id IS NOT NULL;

ALTER TABLE hosts
  ADD COLUMN IF NOT EXISTS create_mutation_id uuid,
  ADD COLUMN IF NOT EXISTS create_email text,
  ADD COLUMN IF NOT EXISTS create_name text,
  ADD COLUMN IF NOT EXISTS create_password_hash text,
  ADD COLUMN IF NOT EXISTS create_role host_role,
  ADD COLUMN IF NOT EXISTS create_language language,
  ADD COLUMN IF NOT EXISTS created_by_host uuid REFERENCES hosts(id);

CREATE UNIQUE INDEX IF NOT EXISTS hosts_create_mutation_uq
  ON hosts(create_mutation_id)
  WHERE create_mutation_id IS NOT NULL;
