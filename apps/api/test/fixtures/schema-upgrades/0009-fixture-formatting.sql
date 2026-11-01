-- Formatting is not an operation identity or a deployment byte fingerprint.
ALTER TABLE workspaces
  ADD COLUMN upgrade_probe text;
