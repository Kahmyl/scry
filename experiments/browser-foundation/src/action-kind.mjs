// Observation operations do not dispatch an application-changing interaction.
// Background app traffic may still occur; its business outcome is not inferred.
export const observationTools = new Set([
  "browser_snapshot",
  "browser_find",
  "browser_wait_for",
  "browser_take_screenshot",
]);
