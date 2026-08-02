ALTER TABLE guests
  ADD COLUMN archive_mutation_id uuid,
  ADD COLUMN archive_expected_version integer,
  ADD COLUMN archived_by_host uuid REFERENCES hosts(id);

CREATE UNIQUE INDEX guests_archive_mutation_uq
  ON guests(archive_mutation_id)
  WHERE archive_mutation_id IS NOT NULL;
