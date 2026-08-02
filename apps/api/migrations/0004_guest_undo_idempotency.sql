ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS guest_undo_mutation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS order_items_guest_undo_mutation_uq
  ON order_items(guest_undo_mutation_id)
  WHERE guest_undo_mutation_id IS NOT NULL;
