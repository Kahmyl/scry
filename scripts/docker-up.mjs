import { spawnSync } from "node:child_process";

run("docker", ["compose", "up", "--build", "--wait"], process.env);

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
