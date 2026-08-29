import { spawnSync } from "node:child_process";

import { deriveRepositorySourceIdentity, sourceIdentityEnvironment } from "./source-identity.mjs";

const sourceIdentity = deriveRepositorySourceIdentity();

run("pnpm", ["verify:release-fingerprint"], process.env);
run("docker", ["compose", "up", "--build", "--wait"], {
  ...process.env,
  ...sourceIdentityEnvironment(sourceIdentity),
  SCRY_RUNTIME_VERSION: process.env.SCRY_RUNTIME_VERSION ?? `node-${process.version}`,
});

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
