ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS void_mutation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS bills_void_mutation_uq
  ON bills(void_mutation_id)
  WHERE void_mutation_id IS NOT NULL;
