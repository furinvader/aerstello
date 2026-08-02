ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS host_name text;

UPDATE bills b
   SET host_name=h.name
  FROM hosts h
 WHERE h.id=b.host_id
   AND b.host_name IS NULL;

ALTER TABLE bills
  ALTER COLUMN host_name SET NOT NULL;
