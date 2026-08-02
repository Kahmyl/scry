import { describe, expect, it } from "vitest";
import { praxisDurableTransactionSchema, praxisFailureSchema, praxisLifecycleEventSchema, praxisRequestSchema, praxisResultSchema, praxisRunObservationSchema, praxisSuccessSchema } from "../src/praxis.js";

const intent = { concept:"save",requiredCapabilities:["pointer_activatable"],preferredEvidence:{roles:["button"],names:["Save"],labels:[],descriptions:[],placeholders:[],inputTypes:[]},scope:{kind:"page"},relations:[],prohibited:["hidden","disabled"],risk:"ordinary",confidence:{requiredFamilies:[],minimum:.5,minimumMargin:.05,minimumFamilyCount:2} } as const;
const request = { schemaVersion:1,transactionId:"tx-1",operationId:"save",intent,operation:{type:"activate"},expectedEffect:{type:"none"},risk:"ordinary",policy:{allowedOrigins:["https://example.test"],actionTimeoutMs:1_000,totalTimeoutMs:2_000},privacy:{state:"normal",allowedChannels:["dom","accessibility"],suppressedChannels:[]},context:{pageId:"page-1",origin:"https://example.test",documentEpoch:0} } as const;
const timing={queuedMs:null,observationMs:1,groundingMs:2,revalidationMs:1,dispatchMs:1,localVerificationMs:0,effectVerificationMs:0,totalMs:5,escalationLevel:null,providerTimings:[]};
const resolution={target:{fingerprint:"a".repeat(64),concept:"save",scopeKind:"page",capabilityDigest:"b".repeat(64)},confidence:.9,runnerUpMargin:.4,evidenceFamilies:["accessibility","structural"],drift:"unchanged",strategy:"native_click"} as const;
const verification={local:"not_required",effect:"not_required",effectType:"none"} as const;
const report=(outcome:"succeeded"|"failed"|"inconclusive"|"cancelled",mutationOutcome:"not_started"|"not_applied"|"applied"|"unknown")=>({schemaVersion:1,transactionId:"tx-1",operationId:"save",outcome,summary:"A complete safe summary.",classification:{provenance:outcome==="succeeded"?"none":"praxis",...(outcome==="succeeded"?{}:{code:"PRAXIS_FAILED"}),mutationOutcome},intentDigest:"c".repeat(64),...(outcome==="succeeded"?{resolution}:{}),verification,timing,qualityFindings:[],safeActions:[],artifactRefs:[]});

describe("Praxis contracts",()=>{
  it("parses the internal request and every terminal result shape",()=>{
    expect(praxisRequestSchema.parse(request)).toEqual(request);
    const success={schemaVersion:1,status:"succeeded",transactionId:"tx-1",operationId:"save",phase:"succeeded",mutationOutcome:"applied",resolution,verification,timing,qualityFindings:[],report:report("succeeded","applied")};
    expect(praxisSuccessSchema.parse(success)).toEqual(success);expect(praxisResultSchema.parse(success)).toEqual(success);
    for(const status of ["failed","inconclusive"] as const){const failure={schemaVersion:1,status,transactionId:"tx-1",operationId:"save",phase:status,code:"PRAXIS_FAILED",provenance:"praxis",retry:"requires_revision",mutationOutcome:"not_started",timing,diagnostics:{reasonCode:"FAILED"},qualityFindings:[],safeActions:["revise_intent"],report:{...report(status,"not_started"),safeActions:["revise_intent"]}};expect(praxisFailureSchema.parse(failure)).toEqual(failure);}
    const cancelled={schemaVersion:1,status:"cancelled",transactionId:"tx-1",operationId:"save",phase:"cancelled",code:"PRAXIS_CANCELLED",provenance:"cancelled",retry:"safe",mutationOutcome:"not_started",timing,diagnostics:{reasonCode:"ABORT_SIGNAL"},qualityFindings:[],safeActions:["retry_after_render"],report:{...report("cancelled","not_started"),classification:{provenance:"cancelled",code:"PRAXIS_CANCELLED",mutationOutcome:"not_started"},safeActions:["retry_after_render"]}};expect(praxisFailureSchema.parse(cancelled)).toEqual(cancelled);
  });
  it("rejects incomplete results and unsafe retry combinations",()=>{
    expect(()=>praxisFailureSchema.parse({schemaVersion:1,status:"failed"})).toThrow();
    const unsafe={schemaVersion:1,status:"inconclusive",transactionId:"tx-1",operationId:"save",phase:"inconclusive",code:"PRAXIS_UNKNOWN",provenance:"praxis",retry:"safe",mutationOutcome:"unknown",timing,diagnostics:{},qualityFindings:[],safeActions:[],report:report("inconclusive","unknown")};expect(()=>praxisFailureSchema.parse(unsafe)).toThrow(/retry-safe/);
  });
  it("rejects protected values, low-level handles, and arbitrary coordinates",()=>{
    expect(()=>praxisRequestSchema.parse({...request,operation:{type:"enter_text",input:{reference:"secret-ref",classification:"known_secret"},value:"must-not-cross-contract"}})).toThrow();
    const success={schemaVersion:1,status:"succeeded",transactionId:"tx-1",operationId:"save",phase:"succeeded",mutationOutcome:"applied",resolution:{...resolution,target:{...resolution.target,locator:"#save",x:10,y:20}},verification,timing,qualityFindings:[],report:report("succeeded","applied")};expect(()=>praxisSuccessSchema.parse(success)).toThrow();
  });
  it("round-trips deterministically and validates lifecycle events",()=>{
    expect(praxisRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(praxisLifecycleEventSchema.parse({schemaVersion:1,transactionId:"tx-1",operationId:"save",type:"praxis.phase_changed",phase:"grounding",occurredAt:new Date().toISOString(),payload:{}}).phase).toBe("grounding");
  });
  it("validates durable transaction and legacy-empty run projections",()=>{
    const result={schemaVersion:1,status:"succeeded",transactionId:"tx-1",operationId:"save",phase:"succeeded",mutationOutcome:"applied",resolution,verification,timing,qualityFindings:[],report:report("succeeded","applied")} as const;
    const durable={transactionId:"tx-1",operationId:"save",stepId:null,schemaVersion:1,runtimeVersion:"1",result,startedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
    expect(praxisDurableTransactionSchema.parse(durable)).toEqual(durable);
    expect(praxisRunObservationSchema.parse({contractVersion:1,runtimeVersions:[],status:"complete",transactions:[],findings:[]})).toMatchObject({transactions:[],findings:[]});
  });
});
