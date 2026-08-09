import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  milestoneCampaignResultSchema,
  missionLiveCampaignResultSchema,
  type MilestoneCampaignResult,
  type MissionLiveCampaignResult,
} from "@scry/contracts";

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

export async function retainMissionLiveCampaignReport(input: {
  directory: string;
  result: MissionLiveCampaignResult;
  forbiddenValues?: readonly string[];
}): Promise<string> {
  const result = missionLiveCampaignResultSchema.parse(input.result);
  await mkdir(input.directory, { recursive: true });
  const safeTarget = result.target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const file = path.join(input.directory, `${result.milestone.toLowerCase()}-${safeTarget}-r${result.repetition}-${result.correlationId}.json`);
  await writeFile(file, serializeSanitizedCampaign(result, input.forbiddenValues), {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}
