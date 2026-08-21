import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const historicalSnapshot = "/private/tmp/scry-m1-cutover-2b9e22e42cf3/development-db.dump";
const apiArguments = ["--filter", "@scry/api", "exec", "vitest", "run"];

if (!existsSync(historicalSnapshot)) {
  process.stdout.write(
    "BETA_QUALIFICATION_GAP: M1_SNAPSHOT_REQUIRED; the immutable M1 snapshot suite is not reported as passing.\n",
  );
  apiArguments.push("--exclude", "test/m1-snapshot-migration.qualification.test.ts");
}

run([
  "--workspace-concurrency=1",
  "--filter",
  "./apps/**",
  "--filter",
  "./packages/**",
  "--filter",
  "!@scry/api",
  "--recursive",
  "test",
]);
run(apiArguments);

function run(arguments_) {
  const result = spawnSync("pnpm", arguments_, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
