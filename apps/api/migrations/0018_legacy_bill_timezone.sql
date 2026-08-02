DO $$
DECLARE
  legacy_timezone text := NULLIF(current_setting('sky_bar.legacy_bill_timezone', true), '');
  timezone_migration_at timestamptz;
BEGIN
  SELECT applied_at INTO timezone_migration_at
    FROM schema_migrations
   WHERE name = '0007_bill_timezone.sql';

  IF EXISTS (SELECT 1 FROM bills WHERE settled_at <= timezone_migration_at) THEN
    IF legacy_timezone IS NULL THEN
      RAISE EXCEPTION 'LEGACY_BILL_TIMEZONE is required to preserve bills settled before the timezone snapshot migration';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = legacy_timezone) THEN
      RAISE EXCEPTION 'LEGACY_BILL_TIMEZONE is not a recognized PostgreSQL timezone';
    END IF;
    UPDATE bills
       SET venue_timezone = legacy_timezone
     WHERE settled_at <= timezone_migration_at;
  END IF;
END $$;
