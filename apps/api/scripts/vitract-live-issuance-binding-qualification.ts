/**
 * Backward-compatible command name for the canonical production composition.
 *
 * Lifecycle creation, observed-contract selection, immutable reservation,
 * authorization, same-owner dispatch, and typed persistence are all owned by
 * VitractCredentialIssuancePreparationService and the Prepared Protected
 * Operation repositories. This wrapper deliberately has no second path.
 */
import { pathToFileURL } from "node:url";

export async function main() {
  const canonical = await import("./vitract-production-credential-issuance.js");
  return canonical.main();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
