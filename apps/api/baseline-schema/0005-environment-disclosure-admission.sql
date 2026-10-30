ALTER TABLE browser_owner_generations
  DROP CONSTRAINT browser_owner_generations_runtime_capability_id_check,
  ADD CONSTRAINT browser_owner_generations_runtime_capability_id_check
    CHECK (runtime_capability_id='browser-execution');

-- Environment disclosure is selected by the trusted user boundary and copied
-- into the Run's browser session. The agent can observe this mode but cannot
-- create or broaden it. No provider-specific field or response-name registry
-- participates in public admission.
