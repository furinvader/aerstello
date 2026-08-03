ALTER TABLE order_items
  ADD COLUMN billing_version integer NOT NULL DEFAULT 0,
  ADD COLUMN host_void_expected_billing_version integer;

-- Immutable bill lines retain every settlement of an order item, including
-- bills that were later reversed. Deriving the epoch from that history keeps
-- old corrected items distinguishable without rewriting financial records.
UPDATE order_items oi
   SET billing_version=history.billing_count
  FROM (
    SELECT original_order_item_id,count(*)::integer AS billing_count
      FROM bill_items
     GROUP BY original_order_item_id
  ) history
 WHERE history.original_order_item_id=oi.id;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_billing_version_check CHECK (billing_version >= 0),
  ADD CONSTRAINT order_items_host_void_expected_billing_version_check
    CHECK (host_void_expected_billing_version IS NULL OR host_void_expected_billing_version >= 0);
