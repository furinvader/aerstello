ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS create_mutation_id uuid,
  ADD COLUMN IF NOT EXISTS create_name text,
  ADD COLUMN IF NOT EXISTS create_room_id uuid REFERENCES rooms(id),
  ADD COLUMN IF NOT EXISTS create_language language,
  ADD COLUMN IF NOT EXISTS created_by_host uuid REFERENCES hosts(id);

CREATE UNIQUE INDEX IF NOT EXISTS guests_create_mutation_uq
  ON guests(create_mutation_id)
  WHERE create_mutation_id IS NOT NULL;
