import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { execFileSync } from "node:child_process";

execFileSync("bash", ["-n", "scripts/deploy-server-release.sh"], { stdio: "inherit" });
execFileSync("node", ["packages/assurance/gates/deploy-server-release.test.mjs"], {
  stdio: "inherit",
});
