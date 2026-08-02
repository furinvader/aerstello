ALTER TABLE order_batches
  ALTER COLUMN command DROP NOT NULL;

UPDATE order_batches
  SET command=NULL
  WHERE command='{}'::jsonb;
