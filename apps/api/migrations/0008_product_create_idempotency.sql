CREATE TABLE IF NOT EXISTS product_create_commands (
  mutation_id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id),
  product_id uuid UNIQUE REFERENCES products(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  name jsonb NOT NULL,
  description jsonb,
  price_cents integer NOT NULL,
  enabled boolean NOT NULL,
  self_service_only boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
