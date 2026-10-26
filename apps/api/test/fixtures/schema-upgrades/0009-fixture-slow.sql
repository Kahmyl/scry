SELECT pg_sleep(0.5);
ALTER TABLE workspaces ADD COLUMN upgrade_probe text;
