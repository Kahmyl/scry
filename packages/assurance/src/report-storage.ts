import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QualificationReport } from "./qualification.js";

export async function retainQualificationReport(
  directory: string,
  report: QualificationReport,
): Promise<string> {
  if (!/^[a-f0-9-]{36}$/u.test(report.runId)) throw new Error("SCRY_ASSURANCE_RUN_ID_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${report.runId}.json`);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return target;
}
