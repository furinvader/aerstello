ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS grant_exchange_id uuid;
