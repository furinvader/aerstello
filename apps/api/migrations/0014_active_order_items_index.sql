CREATE INDEX IF NOT EXISTS order_items_active_status_idx
  ON order_items(status)
  WHERE status IN ('open','provisional');
