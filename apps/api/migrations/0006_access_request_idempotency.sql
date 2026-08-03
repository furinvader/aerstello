ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS mutation_id uuid;

UPDATE access_requests
   SET mutation_id=gen_random_uuid()
 WHERE mutation_id IS NULL;

ALTER TABLE access_requests
  ALTER COLUMN mutation_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS access_requests_mutation_id_uq
  ON access_requests(mutation_id);
