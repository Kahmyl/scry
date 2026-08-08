import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { milestoneCampaignResultSchema, type MilestoneCampaignResult } from "@scry/contracts";

import { serializeSanitizedCampaign } from "./redaction.js";

export async function retainCampaignReport(input: {
  directory: string;
  result: MilestoneCampaignResult;
  forbiddenValues?: readonly string[];
}): Promise<string> {
  const result = milestoneCampaignResultSchema.parse(input.result);
  await mkdir(input.directory, { recursive: true });
  const file = path.join(
    input.directory,
    `${result.milestone.toLowerCase()}-${result.target}-${result.campaignId}.json`,
  );
  await writeFile(file, serializeSanitizedCampaign(result, input.forbiddenValues), {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readCampaignReport(file: string): Promise<MilestoneCampaignResult> {
  return milestoneCampaignResultSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
