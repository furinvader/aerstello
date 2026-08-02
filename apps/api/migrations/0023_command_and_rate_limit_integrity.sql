ALTER TABLE products
  ADD COLUMN archive_mutation_id uuid,
  ADD COLUMN archive_expected_version integer,
  ADD COLUMN archived_by_host uuid REFERENCES hosts(id);

CREATE UNIQUE INDEX products_archive_mutation_uq
  ON products(archive_mutation_id)
  WHERE archive_mutation_id IS NOT NULL;

CREATE TABLE host_account_commands (
  mutation_id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id),
  command_hash text NOT NULL,
  result_name text NOT NULL,
  result_language language NOT NULL,
  result_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_counters (
  scope text NOT NULL,
  key_hash text NOT NULL,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX rate_limit_counters_expiry_idx ON rate_limit_counters(expires_at);
