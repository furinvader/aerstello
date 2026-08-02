ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS guest_expected_product_version integer;
