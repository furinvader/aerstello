ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS host_name_known boolean;

UPDATE bills
   SET host_name='',
       host_name_known=false
 WHERE host_name_known IS NULL
   AND settled_at <= (
     SELECT applied_at
       FROM schema_migrations
      WHERE name='0021_bill_host_snapshot.sql'
   );

UPDATE bills
   SET host_name_known=true
 WHERE host_name_known IS NULL;

ALTER TABLE bills
  ALTER COLUMN host_name_known SET DEFAULT true,
  ALTER COLUMN host_name_known SET NOT NULL;
