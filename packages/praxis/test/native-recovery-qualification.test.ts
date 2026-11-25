import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
const exec = promisify(execFile);
const builder = new URL(
  "./fixtures/native-observation-recovery/build-application.mjs",
  import.meta.url,
);
const guards = new URL("./native-input-guards.browser.mjs", import.meta.url);
const qualification = new URL(
  "./fixtures/native-observation-recovery/qualification.ts",
  import.meta.url,
);
const output = new URL("../../../artifacts/assurance/native-action-recovery/", import.meta.url);

it.skipIf(process.env.SCRY_NATIVE_RECOVERY_QUALIFY !== "1")(
  "qualifies native input events, partial plans and uncertain worker loss in isolated fixtures",
  async () => {
    await mkdir(output, { recursive: true });
    await exec(process.execPath, [fileURLToPath(builder)]);
    for (const [name, args] of [
      ["guards", ["--test", fileURLToPath(guards)]],
      ["worker", ["--import", "tsx", "--test", fileURLToPath(qualification)]],
    ] as const) {
      try {
        const result = await exec(process.execPath, [...args], {
          timeout: 90000,
          maxBuffer: 4 * 1024 * 1024,
        });
        await writeFile(new URL(name + ".log", output), result.stdout + result.stderr);
      } catch (error) {
        const result = error as Error & { stdout?: string; stderr?: string };
        await writeFile(
          new URL(name + ".log", output),
          (result.stdout ?? "") + (result.stderr ?? ""),
        );
        throw error;
      }
    }
  },
  120000,
);
