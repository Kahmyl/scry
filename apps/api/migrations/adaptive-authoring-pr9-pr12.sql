ALTER TABLE flow_compilations
  ADD COLUMN IF NOT EXISTS contract_version text NOT NULL DEFAULT 'v1-existing'
    CHECK(contract_version IN ('v1-existing','v2-learned-interactions')),
  ADD COLUMN IF NOT EXISTS learned_interaction_records jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS protected_acquisition_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS publication_gate jsonb NOT NULL DEFAULT '{"status":"not_required","rejectionReasons":[],"requiredOutcome":"application_pass"}'::jsonb,
  ADD COLUMN IF NOT EXISTS certification_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS publication_state text NOT NULL DEFAULT 'published'
    CHECK(publication_state IN ('candidate','published'));

ALTER TABLE flow_revisions
  ADD COLUMN IF NOT EXISTS publication_state text NOT NULL DEFAULT 'published'
    CHECK(publication_state IN ('candidate','published'));

CREATE TABLE IF NOT EXISTS release_gate_metrics (
  id bigserial PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid REFERENCES missions(id) ON DELETE CASCADE,
  objective_id uuid REFERENCES mission_objectives(id) ON DELETE CASCADE,
  compilation_id uuid REFERENCES flow_compilations(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN (
    'authoring',
    'praxis',
    'compiler',
    'quality',
    'protected_acquisition',
    'certification',
    'publication'
  )),
  name text NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL DEFAULT 'count' CHECK(unit IN ('count','ratio','ms')),
  safe_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flow_compilations_publication_gate_idx
  ON flow_compilations((publication_gate->>'status'), created_at DESC);

CREATE INDEX IF NOT EXISTS release_gate_metrics_compilation_idx
  ON release_gate_metrics(compilation_id, category, recorded_at DESC);

CREATE INDEX IF NOT EXISTS flows_published_project_idx
  ON flows(project_id, updated_at DESC)
  WHERE publication_state='published';
