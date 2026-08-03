CREATE FUNCTION enforce_order_item_billing_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('open', 'provisional')
     AND NEW.status = 'voided'
     AND NEW.host_void_mutation_id IS NOT NULL
     AND NEW.host_void_expected_billing_version IS DISTINCT FROM OLD.billing_version
     AND NOT (OLD.billing_version = 0 AND NEW.host_void_expected_billing_version IS NULL) THEN
    -- Pre-upgrade replicas cannot supply an expected version. They may still
    -- void never-billed items, but must not remove an item reopened by reversal.
    RAISE EXCEPTION 'Host item void billing version must match the current item version';
  END IF;

  IF OLD.status IS DISTINCT FROM 'billed' AND NEW.status = 'billed' THEN
    -- Replicas running before billing_version existed leave the value unchanged.
    -- Current replicas already supply the one valid advance themselves.
    IF NEW.billing_version = OLD.billing_version THEN
      NEW.billing_version := OLD.billing_version + 1;
    ELSIF NEW.billing_version <> OLD.billing_version + 1 THEN
      RAISE EXCEPTION 'Order item billing version must advance exactly once when billed';
    END IF;
  ELSIF NEW.billing_version <> OLD.billing_version THEN
    RAISE EXCEPTION 'Order item billing version may change only when entering billed status';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_enforce_billing_version
BEFORE UPDATE OF status, billing_version ON order_items
FOR EACH ROW
EXECUTE FUNCTION enforce_order_item_billing_version();
