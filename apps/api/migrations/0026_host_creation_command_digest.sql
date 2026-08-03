ALTER TABLE hosts
  ADD COLUMN create_command_hash text;

ALTER TABLE hosts
  DROP COLUMN create_password_hash;
