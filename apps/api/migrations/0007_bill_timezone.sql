ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS venue_timezone text;

UPDATE bills b
   SET venue_timezone=v.timezone
  FROM venue_settings v
 WHERE v.id=1 AND b.venue_timezone IS NULL;

ALTER TABLE bills
  ALTER COLUMN venue_timezone SET NOT NULL;
