ALTER TABLE browser_owner_generations
  DROP CONSTRAINT browser_owner_generations_runtime_capability_version_check,
  ADD CONSTRAINT browser_owner_generations_runtime_capability_version_check
    CHECK (runtime_capability_version='browser-runtime-v2.4');

-- Environment disclosure is selected by the trusted user boundary and copied
-- into the Run's browser session. The agent can observe this mode but cannot
-- create or broaden it. No provider-specific field or response-name registry
-- participates in public admission.
