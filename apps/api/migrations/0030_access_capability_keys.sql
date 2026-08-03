ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS status_token_key_id text;

CREATE UNIQUE INDEX IF NOT EXISTS guest_sessions_request_id_uq
  ON guest_sessions(request_id);
