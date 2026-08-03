ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS create_mutation_id uuid,
  ADD COLUMN IF NOT EXISTS create_name jsonb,
  ADD COLUMN IF NOT EXISTS created_by_host uuid REFERENCES hosts(id);

CREATE UNIQUE INDEX IF NOT EXISTS categories_create_mutation_uq
  ON categories(create_mutation_id)
  WHERE create_mutation_id IS NOT NULL;
