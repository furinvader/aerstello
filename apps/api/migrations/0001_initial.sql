CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE host_role AS ENUM ('admin','staff'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE language AS ENUM ('de','it','en'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE item_source AS ENUM ('host','guest'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE item_status AS ENUM ('provisional','open','voided','billed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE request_status AS ENUM ('pending','approved','denied','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_method AS ENUM ('cash','card','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS venue_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), name text NOT NULL DEFAULT '', default_language language NOT NULL DEFAULT 'de',
  timezone text NOT NULL DEFAULT 'Europe/Berlin', catalog_version integer NOT NULL DEFAULT 1, version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO venue_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, name text NOT NULL, password_hash text NOT NULL,
  role host_role NOT NULL DEFAULT 'staff', language language NOT NULL DEFAULT 'de', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hosts_email_lower_uq ON hosts (lower(email));
CREATE TABLE IF NOT EXISTS host_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), host_id uuid NOT NULL REFERENCES hosts(id), token_hash text NOT NULL UNIQUE,
  user_agent text NOT NULL DEFAULT 'Unknown device', created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS host_sessions_host_idx ON host_sessions(host_id);
CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, position integer NOT NULL DEFAULT 0,
  archived_at timestamptz, version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, room_id uuid NOT NULL REFERENCES rooms(id),
  language language NOT NULL DEFAULT 'de', archived_at timestamptz, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guests_room_idx ON guests(room_id);
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name jsonb NOT NULL, position integer NOT NULL DEFAULT 0,
  archived_at timestamptz, version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES categories(id), name jsonb NOT NULL,
  description jsonb, price_cents integer NOT NULL CHECK (price_cents >= 0), enabled boolean NOT NULL DEFAULT true,
  self_service_only boolean NOT NULL DEFAULT false, position integer NOT NULL DEFAULT 0, catalog_version integer NOT NULL,
  archived_at timestamptz, version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS product_versions (
  product_id uuid NOT NULL REFERENCES products(id), catalog_version integer NOT NULL, name jsonb NOT NULL,
  price_cents integer NOT NULL, enabled boolean NOT NULL, self_service_only boolean NOT NULL,
  PRIMARY KEY(product_id, catalog_version)
);
CREATE TABLE IF NOT EXISTS order_tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_id uuid NOT NULL REFERENCES guests(id), status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_tab_per_guest ON order_tabs(guest_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS order_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mutation_id uuid NOT NULL UNIQUE, tab_id uuid NOT NULL REFERENCES order_tabs(id),
  host_id uuid NOT NULL REFERENCES hosts(id), captured_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE, tab_id uuid NOT NULL REFERENCES order_tabs(id),
  guest_id uuid NOT NULL REFERENCES guests(id), host_id uuid NOT NULL REFERENCES hosts(id), mutation_id uuid NOT NULL UNIQUE,
  venue_name text NOT NULL, guest_name text NOT NULL, room_name text NOT NULL, total_cents integer NOT NULL,
  payment_method payment_method NOT NULL, payment_note text, settled_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz, void_reason text, voided_by uuid REFERENCES hosts(id)
);
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tab_id uuid NOT NULL REFERENCES order_tabs(id), batch_id uuid REFERENCES order_batches(id),
  product_id uuid NOT NULL REFERENCES products(id), product_name jsonb NOT NULL, unit_price_cents integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0), source item_source NOT NULL, status item_status NOT NULL DEFAULT 'open',
  submitted_by_host uuid REFERENCES hosts(id), submitted_by_guest_session uuid, provisional_until timestamptz,
  guest_mutation_id uuid UNIQUE, bill_id uuid REFERENCES bills(id), voided_at timestamptz, voided_by_host uuid REFERENCES hosts(id), void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_items_tab_idx ON order_items(tab_id);
CREATE TABLE IF NOT EXISTS bill_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bill_id uuid NOT NULL REFERENCES bills(id), original_order_item_id uuid NOT NULL REFERENCES order_items(id),
  product_name jsonb NOT NULL, unit_price_cents integer NOT NULL, quantity integer NOT NULL, source item_source NOT NULL
);
CREATE INDEX IF NOT EXISTS bill_items_bill_idx ON bill_items(bill_id);
CREATE TABLE IF NOT EXISTS access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, room_id uuid NOT NULL REFERENCES rooms(id), language language NOT NULL DEFAULT 'de',
  status request_status NOT NULL DEFAULT 'pending', status_token_hash text NOT NULL UNIQUE, guest_id uuid REFERENCES guests(id),
  requested_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by uuid REFERENCES hosts(id), expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_id uuid NOT NULL REFERENCES guests(id), request_id uuid NOT NULL REFERENCES access_requests(id),
  token_hash text NOT NULL UNIQUE, user_agent text NOT NULL DEFAULT 'Unknown device', created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_submitted_by_guest_session_fkey;
ALTER TABLE order_items ADD CONSTRAINT order_items_submitted_by_guest_session_fkey FOREIGN KEY (submitted_by_guest_session) REFERENCES guest_sessions(id);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_host_id uuid REFERENCES hosts(id), actor_guest_session_id uuid REFERENCES guest_sessions(id),
  action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS realtime_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
