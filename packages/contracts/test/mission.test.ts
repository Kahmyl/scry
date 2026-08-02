import { describe,expect,it } from "vitest";
import { acceptEvidenceSchema,createMissionSchema,missionResumePointerSchema,publishMissionReportSchema } from "../src/index.js";

const ids={missionId:"11111111-1111-4111-8111-111111111111",objectiveId:"22222222-2222-4222-8222-222222222222",agentSessionId:"33333333-3333-4333-8333-333333333333",runId:"44444444-4444-4444-8444-444444444444"};
describe("Mission contracts",()=>{
  it("requires durable instruction identity",()=>{expect(createMissionSchema.safeParse({title:"Partner workflow",originalInstruction:"Test it",instructionSnapshot:"Test it",provider:"codex",idempotencyKey:"mission-key-1"}).success).toBe(true);expect(createMissionSchema.safeParse({title:"Missing instruction",idempotencyKey:"mission-key-2"}).success).toBe(false);});
  it("rejects an unscoped resume target",()=>{expect(missionResumePointerSchema.safeParse({objectiveId:ids.objectiveId,recommendedAction:"run_candidate",runId:"not-a-uuid",explanation:"Run it"}).success).toBe(false);});
  it("requires explicit accepted evidence context",()=>{expect(acceptEvidenceSchema.safeParse({missionId:ids.missionId,agentSessionId:ids.agentSessionId,runId:ids.runId,artifactIds:[],conclusion:"Passed"}).success).toBe(true);expect(acceptEvidenceSchema.safeParse({runId:ids.runId,artifactIds:[],conclusion:"Passed"}).success).toBe(false);});
  it("requires optimistic report publication",()=>{expect(publishMissionReportSchema.safeParse({missionId:ids.missionId,agentSessionId:ids.agentSessionId,overallConclusion:"Complete",journeySummary:["Passed"],remainingActions:[],expectedRevision:3}).success).toBe(true);});
});
