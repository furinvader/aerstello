CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE host_role AS ENUM ('admin', 'staff');
CREATE TYPE language AS ENUM ('de', 'it', 'en');
CREATE TYPE item_source AS ENUM ('host', 'guest');
CREATE TYPE item_status AS ENUM ('provisional', 'open', 'voided', 'billed');
CREATE TYPE request_status AS ENUM ('pending', 'approved', 'denied', 'expired');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'other');

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venue_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL DEFAULT '',
  default_language language NOT NULL DEFAULT 'de',
  timezone text NOT NULL DEFAULT 'Europe/Berlin',
  catalog_version integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO venue_settings (id) VALUES (1);

CREATE TABLE hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role host_role NOT NULL DEFAULT 'staff',
  language language NOT NULL DEFAULT 'de',
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  create_mutation_id uuid,
  create_email text,
  create_name text,
  create_command_hash text,
  create_role host_role,
  create_language language,
  created_by_host uuid REFERENCES hosts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hosts_email_lower_uq ON hosts (lower(email));
CREATE UNIQUE INDEX hosts_create_mutation_uq ON hosts(create_mutation_id) WHERE create_mutation_id IS NOT NULL;

CREATE TABLE host_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts(id),
  token_hash text NOT NULL UNIQUE,
  user_agent text NOT NULL DEFAULT 'Unknown device',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX host_sessions_host_idx ON host_sessions(host_id);

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  create_mutation_id uuid,
  create_name text,
  created_by_host uuid REFERENCES hosts(id),
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  archive_mutation_id uuid,
  archive_expected_version integer,
  archived_by_host uuid REFERENCES hosts(id),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX rooms_create_mutation_uq ON rooms(create_mutation_id) WHERE create_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX rooms_archive_mutation_uq ON rooms(archive_mutation_id) WHERE archive_mutation_id IS NOT NULL;

CREATE TABLE guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id),
  language language NOT NULL DEFAULT 'de',
  create_mutation_id uuid,
  create_name text,
  create_room_id uuid REFERENCES rooms(id),
  create_language language,
  created_by_host uuid REFERENCES hosts(id),
  archived_at timestamptz,
  archive_mutation_id uuid,
  archive_expected_version integer,
  archived_by_host uuid REFERENCES hosts(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guests_room_idx ON guests(room_id);
CREATE UNIQUE INDEX guests_create_mutation_uq ON guests(create_mutation_id) WHERE create_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX guests_archive_mutation_uq ON guests(archive_mutation_id) WHERE archive_mutation_id IS NOT NULL;

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name jsonb NOT NULL,
  create_mutation_id uuid,
  create_name jsonb,
  created_by_host uuid REFERENCES hosts(id),
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX categories_create_mutation_uq ON categories(create_mutation_id) WHERE create_mutation_id IS NOT NULL;

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  name jsonb NOT NULL,
  description jsonb,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  enabled boolean NOT NULL DEFAULT true,
  self_service_only boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  catalog_version integer NOT NULL,
  archived_at timestamptz,
  archive_mutation_id uuid,
  archive_expected_version integer,
  archived_by_host uuid REFERENCES hosts(id),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX products_archive_mutation_uq ON products(archive_mutation_id) WHERE archive_mutation_id IS NOT NULL;

CREATE TABLE product_versions (
  product_id uuid NOT NULL REFERENCES products(id),
  catalog_version integer NOT NULL,
  name jsonb NOT NULL,
  price_cents integer NOT NULL,
  enabled boolean NOT NULL,
  self_service_only boolean NOT NULL,
  PRIMARY KEY (product_id, catalog_version)
);

CREATE TABLE product_create_commands (
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

CREATE TABLE host_account_commands (
  mutation_id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id),
  command_hash text NOT NULL,
  result_name text NOT NULL,
  result_language language NOT NULL,
  result_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id uuid NOT NULL,
  name text NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id),
  language language NOT NULL DEFAULT 'de',
  status request_status NOT NULL DEFAULT 'pending',
  status_token_hash text NOT NULL UNIQUE,
  status_token_key_id text NOT NULL,
  guest_id uuid REFERENCES guests(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES hosts(id),
  expires_at timestamptz,
  approval_mutation_id uuid,
  approval_linked_guest_id uuid REFERENCES guests(id),
  approval_expires_at timestamptz,
  denial_mutation_id uuid,
  status_token_consumed_at timestamptz,
  grant_exchange_id uuid
);
CREATE UNIQUE INDEX access_requests_mutation_id_uq ON access_requests(mutation_id);
CREATE UNIQUE INDEX access_requests_approval_mutation_uq ON access_requests(approval_mutation_id) WHERE approval_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX access_requests_denial_mutation_uq ON access_requests(denial_mutation_id) WHERE denial_mutation_id IS NOT NULL;

CREATE TABLE guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id),
  request_id uuid NOT NULL REFERENCES access_requests(id),
  token_hash text NOT NULL UNIQUE,
  user_agent text NOT NULL DEFAULT 'Unknown device',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX guest_sessions_request_id_uq ON guest_sessions(request_id);

CREATE TABLE order_tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id),
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE UNIQUE INDEX one_open_tab_per_guest ON order_tabs(guest_id) WHERE status = 'open';

CREATE TABLE order_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id uuid NOT NULL UNIQUE,
  tab_id uuid NOT NULL REFERENCES order_tabs(id),
  host_id uuid NOT NULL REFERENCES hosts(id),
  command jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tab_id uuid NOT NULL REFERENCES order_tabs(id),
  guest_id uuid NOT NULL REFERENCES guests(id),
  host_id uuid NOT NULL REFERENCES hosts(id),
  mutation_id uuid NOT NULL UNIQUE,
  venue_name text NOT NULL,
  venue_timezone text NOT NULL,
  guest_name text NOT NULL,
  room_name text NOT NULL,
  host_name text NOT NULL,
  total_cents integer NOT NULL,
  payment_method payment_method NOT NULL,
  payment_note text,
  settled_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text,
  voided_by uuid REFERENCES hosts(id),
  void_mutation_id uuid
);
CREATE INDEX bills_settled_idx ON bills(settled_at);
CREATE UNIQUE INDEX bills_void_mutation_uq ON bills(void_mutation_id) WHERE void_mutation_id IS NOT NULL;

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id uuid NOT NULL REFERENCES order_tabs(id),
  batch_id uuid REFERENCES order_batches(id),
  product_id uuid NOT NULL REFERENCES products(id),
  product_name jsonb NOT NULL,
  unit_price_cents integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  source item_source NOT NULL,
  status item_status NOT NULL DEFAULT 'open',
  submitted_by_host uuid REFERENCES hosts(id),
  submitted_by_guest_session uuid REFERENCES guest_sessions(id),
  provisional_until timestamptz,
  guest_mutation_id uuid UNIQUE,
  guest_expected_price_cents integer,
  guest_expected_product_version integer,
  billing_version integer NOT NULL DEFAULT 0 CHECK (billing_version >= 0),
  bill_id uuid REFERENCES bills(id),
  voided_at timestamptz,
  voided_by_host uuid REFERENCES hosts(id),
  void_reason text,
  host_void_mutation_id uuid,
  host_void_expected_billing_version integer,
  guest_undo_mutation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_guest_snapshot_check CHECK (
    source <> 'guest' OR (
      guest_expected_price_cents IS NOT NULL
      AND guest_expected_price_cents >= 0
      AND guest_expected_product_version IS NOT NULL
      AND guest_expected_product_version > 0
    )
  ),
  CONSTRAINT order_items_host_void_expected_billing_version_check CHECK (
    host_void_expected_billing_version IS NULL OR host_void_expected_billing_version >= 0
  )
);
CREATE INDEX order_items_tab_idx ON order_items(tab_id);
CREATE INDEX order_items_active_status_idx ON order_items(status) WHERE status IN ('open', 'provisional');
CREATE UNIQUE INDEX order_items_host_void_mutation_uq ON order_items(host_void_mutation_id) WHERE host_void_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX order_items_guest_undo_mutation_uq ON order_items(guest_undo_mutation_id) WHERE guest_undo_mutation_id IS NOT NULL;

CREATE TABLE bill_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id),
  original_order_item_id uuid NOT NULL REFERENCES order_items(id),
  product_name jsonb NOT NULL,
  unit_price_cents integer NOT NULL,
  quantity integer NOT NULL,
  source item_source NOT NULL
);
CREATE INDEX bill_items_bill_idx ON bill_items(bill_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_host_id uuid REFERENCES hosts(id),
  actor_guest_session_id uuid REFERENCES guest_sessions(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE realtime_event_commit_lock (
  singleton boolean PRIMARY KEY DEFAULT true,
  CONSTRAINT realtime_event_commit_lock_singleton_check CHECK (singleton)
);
INSERT INTO realtime_event_commit_lock(singleton) VALUES (true);

CREATE TABLE realtime_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
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

CREATE FUNCTION serialize_realtime_event_inserts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM singleton
    FROM realtime_event_commit_lock
   WHERE singleton
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Realtime event commit lock row is missing';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER realtime_events_serialize_inserts
BEFORE INSERT ON realtime_events
FOR EACH STATEMENT
EXECUTE FUNCTION serialize_realtime_event_inserts();

CREATE FUNCTION enforce_bill_item_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Bill items are immutable and cannot be updated or deleted';
END;
$$;

CREATE TRIGGER bill_items_enforce_immutability
BEFORE UPDATE OR DELETE ON bill_items
FOR EACH ROW
EXECUTE FUNCTION enforce_bill_item_immutability();

CREATE FUNCTION reject_bill_items_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Bill items are immutable and cannot be truncated';
END;
$$;

CREATE TRIGGER bill_items_reject_truncate
BEFORE TRUNCATE ON bill_items
FOR EACH STATEMENT
EXECUTE FUNCTION reject_bill_items_truncate();

CREATE FUNCTION enforce_bill_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bills are immutable and cannot be deleted';
  END IF;

  IF OLD.voided_at IS NULL
     AND OLD.void_reason IS NULL
     AND OLD.voided_by IS NULL
     AND OLD.void_mutation_id IS NULL
     AND NEW.voided_at IS NOT NULL
     AND NEW.void_reason IS NOT NULL
     AND NEW.voided_by IS NOT NULL
     AND NEW.void_mutation_id IS NOT NULL
     AND to_jsonb(NEW) - ARRAY['voided_at', 'void_reason', 'voided_by', 'void_mutation_id']
         = to_jsonb(OLD) - ARRAY['voided_at', 'void_reason', 'voided_by', 'void_mutation_id'] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Bills are immutable except for the complete audited void transition';
END;
$$;

CREATE TRIGGER bills_enforce_immutability
BEFORE UPDATE OR DELETE ON bills
FOR EACH ROW
EXECUTE FUNCTION enforce_bill_immutability();

CREATE FUNCTION verify_bill_void_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT count(*)
        FROM audit_events
       WHERE action = 'bill.voided'
         AND entity_type = 'bill'
         AND entity_id = NEW.id::text) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM audit_events
        WHERE action = 'bill.voided'
          AND entity_type = 'bill'
          AND entity_id = NEW.id::text
          AND actor_host_id = NEW.voided_by
          AND detail->>'reason' = NEW.void_reason
          AND detail->>'mutationId' = NEW.void_mutation_id::text
     ) THEN
    RAISE EXCEPTION 'A bill void requires exactly one matching audit event';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER bills_verify_void_audit_event
AFTER UPDATE ON bills
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_bill_void_audit_event();

CREATE FUNCTION enforce_order_item_billing_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'billed' THEN
      RAISE EXCEPTION 'Billed order items are immutable and cannot be deleted';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD.status = 'billed' THEN
    IF OLD.bill_id IS NULL
       OR NEW.status <> 'open'
       OR NEW.bill_id IS NOT NULL
       OR to_jsonb(NEW) - ARRAY['tab_id', 'status', 'bill_id']
          <> to_jsonb(OLD) - ARRAY['tab_id', 'status', 'bill_id'] THEN
      RAISE EXCEPTION 'Billed order items are immutable except during audited bill reversal';
    END IF;

    PERFORM 1
      FROM bills b
      JOIN order_tabs t ON t.id = NEW.tab_id
     WHERE b.id = OLD.bill_id
       AND b.voided_at IS NOT NULL
       AND b.void_reason IS NOT NULL
       AND b.voided_by IS NOT NULL
       AND b.void_mutation_id IS NOT NULL
       AND t.status = 'open'
       AND t.guest_id = b.guest_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billed order items may reopen only onto their guest''s open tab after bill reversal';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status IN ('open', 'provisional')
     AND NEW.status = 'voided'
     AND NEW.host_void_mutation_id IS NOT NULL
     AND NEW.host_void_expected_billing_version IS DISTINCT FROM OLD.billing_version THEN
    RAISE EXCEPTION 'Host item void billing version must match the current item version';
  END IF;

  IF OLD.status IS DISTINCT FROM 'billed' AND NEW.status = 'billed' THEN
    IF NEW.billing_version <> OLD.billing_version + 1 THEN
      RAISE EXCEPTION 'Order item billing version must advance exactly once when billed';
    END IF;
  ELSIF NEW.billing_version <> OLD.billing_version THEN
    RAISE EXCEPTION 'Order item billing version may change only when entering billed status';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_enforce_billing_version
BEFORE UPDATE OR DELETE ON order_items
FOR EACH ROW
EXECUTE FUNCTION enforce_order_item_billing_version();
