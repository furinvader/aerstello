ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS approval_mutation_id uuid,
  ADD COLUMN IF NOT EXISTS approval_linked_guest_id uuid REFERENCES guests(id),
  ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS access_requests_approval_mutation_uq
  ON access_requests(approval_mutation_id)
  WHERE approval_mutation_id IS NOT NULL;
