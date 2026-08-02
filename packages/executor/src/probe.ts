import { createHash } from "node:crypto";
import type { CurrentPlan, ExecutionPolicy, InteractionTargetIntent } from "@scry/contracts";
import { chromium } from "playwright";

import { executePlan } from "./executor.js";
import { browserObservationRuntimeHealth, GroundingError, resolveTarget } from "./grounding.js";
import type { BrowserStorageState } from "./types.js";
import { playwrightBrowserChannel } from "./browser-runtime-artifacts.js";

export type ProbeExecutionLevel="inspection"|"reversible"|"calibration_transaction";
export type ProbeExecutionResult={allResolved:boolean;runtimeHealthy:boolean;targets:Array<Record<string,unknown>>;readiness:Array<Record<string,unknown>>;diagnostics:Array<Record<string,unknown>>;pageFingerprint:string;authenticationFingerprint?:string;execution?:Record<string,unknown>};

export async function probeFlowPlan(input:{plan:CurrentPlan;level:ProbeExecutionLevel;policy:ExecutionPolicy;browserChannel:string;outputDirectory:string;secretResolver?:(reference:string)=>Promise<string>;captureBrowserState?:(state:BrowserStorageState)=>void|Promise<void>}):Promise<ProbeExecutionResult>{
  const runtime=browserObservationRuntimeHealth();if(!runtime.healthy)return{allResolved:false,runtimeHealthy:false,targets:[],readiness:[],diagnostics:runtime.diagnostics,pageFingerprint:hash("runtime-unhealthy")};
  if(input.level!=="inspection"){
    const steps=input.level==="reversible"?input.plan.steps.filter((step)=>reversible(step.action)):input.plan.steps;
    const options={plan:{...input.plan,steps},policy:input.policy,outputDirectory:input.outputDirectory,browserChannel:input.browserChannel,...(input.secretResolver?{secretResolver:input.secretResolver}:{}),...(input.captureBrowserState?{captureBrowserState:input.captureBrowserState}:{})};
    const report=await executePlan(options);
    const diagnostics=report.steps.flatMap((step)=>step.action.status==="failed"||step.readiness?.status==="failed"?[{code:step.action.error??step.readiness?.error??"PROBE_STEP_FAILED",stepId:step.id,channel:step.action.status==="failed"?"target":"readiness"}]:[]);
    return{allResolved:report.state==="passed",runtimeHealthy:report.state!=="infrastructure_error",targets:report.steps.map(step=>({stepId:step.id,status:step.action.status})),readiness:report.steps.map(step=>({stepId:step.id,...step.readiness})),diagnostics,pageFingerprint:hash({state:report.state,steps:report.steps.map(step=>[step.id,step.action.status,step.readiness?.status])}),execution:{state:report.state,outcomeClassification:report.outcomeClassification}};
  }
  const browserChannel=playwrightBrowserChannel(input.browserChannel);const browser=await chromium.launch({headless:true,...(browserChannel?{channel:browserChannel}:{})});const targets:Array<Record<string,unknown>>=[];const readiness:Array<Record<string,unknown>>=[];const diagnostics:Array<Record<string,unknown>>=[];const page=await browser.newPage();const pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.message));
  try{
    for(const step of input.plan.steps){if(step.action.type==="navigate"){await page.goto(step.action.url,{waitUntil:"domcontentloaded"}).catch(error=>diagnostics.push({code:"PROBE_NAVIGATION_FAILED",stepId:step.id,message:safe(error)}));continue;}const target=actionTarget(step.action);if(target)await inspectTarget(page,step.id,"action",target,targets,diagnostics);for(const condition of step.after?.conditions??[]){const candidate="target"in condition?condition.target:undefined;if(candidate)await inspectTarget(page,step.id,"readiness",candidate,readiness,diagnostics);}}
    for(const message of pageErrors)diagnostics.push({code:message.includes("__name")?"BROWSER_RUNTIME_UNHEALTHY":"PAGE_RUNTIME_ERROR",message});
    return{allResolved:diagnostics.length===0,runtimeHealthy:!pageErrors.some(item=>item.includes("__name")),targets,readiness,diagnostics,pageFingerprint:hash({url:page.url(),targets:targets.map(item=>item.fingerprint)})};
  }finally{await browser.close();}
}

async function inspectTarget(page:import("playwright").Page,stepId:string,channel:string,target:InteractionTargetIntent,output:Array<Record<string,unknown>>,diagnostics:Array<Record<string,unknown>>){try{const resolved=await resolveTarget(page,target);output.push({stepId,channel,status:"resolved",confidence:resolved.diagnostic.confidence,confidenceMargin:resolved.diagnostic.confidenceMargin,fingerprint:resolved.diagnostic.selectedFingerprint,adapter:resolved.adapter});}catch(error){if(error instanceof GroundingError)diagnostics.push({code:error.code,stepId,channel,...error.diagnostic});else diagnostics.push({code:"PROBE_OBSERVATION_FAILED",stepId,channel,message:safe(error)});}}
function actionTarget(action:CurrentPlan["steps"][number]["action"]):InteractionTargetIntent|undefined{return"target"in action?action.target as InteractionTargetIntent:undefined;}
function reversible(action:CurrentPlan["steps"][number]["action"]){if(["navigate","fill","select","check","press","scroll","waitFor","screenshot","capturePublicValue"].includes(action.type))return true;if(action.type==="click")return action.target.risk==="read_only"||action.expectedEffect.type==="none"||action.expectedEffect.type==="visibility_change"||action.expectedEffect.type==="state_change";return false;}
function safe(error:unknown){const value=error instanceof Error?error.message:String(error);return/^[A-Z][A-Z0-9_:-]*$/.test(value)?value:"PROBE_DEPENDENCY_FAILURE";}
function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
