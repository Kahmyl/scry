import { execFileSync } from "node:child_process";

execFileSync("bash", ["-n", "scripts/deploy-server-release.sh"], { stdio: "inherit" });
execFileSync("node", ["scripts/deploy-server-release.test.mjs"], { stdio: "inherit" });
