-- Historical objective conclusions cannot be attributed back to individual
-- attempts. Leave those rows NULL; preserve each new attempt's own conclusion.
ALTER TABLE runs ADD COLUMN conclusion text;
