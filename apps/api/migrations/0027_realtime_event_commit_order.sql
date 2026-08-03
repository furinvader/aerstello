CREATE TABLE realtime_event_commit_lock (
  singleton boolean PRIMARY KEY DEFAULT true,
  CONSTRAINT realtime_event_commit_lock_singleton_check CHECK (singleton)
);

INSERT INTO realtime_event_commit_lock(singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE FUNCTION serialize_realtime_event_inserts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM singleton
    FROM realtime_event_commit_lock
   WHERE singleton
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Realtime event commit lock row is missing';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER realtime_events_serialize_inserts
BEFORE INSERT ON realtime_events
FOR EACH STATEMENT
EXECUTE FUNCTION serialize_realtime_event_inserts();
