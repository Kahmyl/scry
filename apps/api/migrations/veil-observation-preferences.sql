CREATE TABLE IF NOT EXISTS veil_environment_preferences (
  environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS veil_preference_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  previous_policy_digest text NOT NULL CHECK(previous_policy_digest ~ '^[a-f0-9]{64}$'),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL DEFAULT 'PREFERENCE_TIGHTENED' CHECK(reason_code = 'PREFERENCE_TIGHTENED'),
  safe_reason text NOT NULL CHECK(length(safe_reason) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS veil_preference_audit_environment_idx
  ON veil_preference_audit(environment_id, updated_at DESC);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS veil_policy_snapshot jsonb;
UPDATE runs SET veil_policy_snapshot = jsonb_build_object(
  'schemaVersion', 1,
  'profile', 'balanced',
  'allowedOrigins', policy_snapshot->'allowedOrigins',
  'controls', jsonb_build_object(
    'screenshots', true, 'video', true, 'dom', true, 'accessibility', true,
    'diagnostics', true, 'network', true, 'trace', true, 'clipboard', false,
    'downloads', false, 'maskSensitiveVisuals', true,
    'sanitizeStructuredEvidence', true, 'quarantineUnknown', true
  ),
  'leaseTtlMs', 5000,
  'digest', repeat('0', 64)
)
WHERE veil_policy_snapshot IS NULL;
ALTER TABLE runs ALTER COLUMN veil_policy_snapshot SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_veil_policy_snapshot_valid'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs ADD CONSTRAINT runs_veil_policy_snapshot_valid CHECK (
      (veil_policy_snapshot->>'schemaVersion')::integer = 1
      AND veil_policy_snapshot->>'digest' ~ '^[a-f0-9]{64}$'
    );
  END IF;
END $$;
