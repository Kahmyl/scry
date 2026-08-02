import { describe, expect, it } from "vitest";
import { PraxisBudget, PraxisMetrics, escalationLevel } from "../src/praxis-latency.js";

describe("Praxis adaptive latency policy",()=>{
  it("selects deterministic escalation levels without weakening refusal",()=>{
    expect(escalationLevel({historyCompatible:true,semanticAuthoritative:true,behaviorRequired:false,visualUsed:false,adapterUsed:false,budgetExhausted:false})).toBe(0);
    expect(escalationLevel({historyCompatible:false,semanticAuthoritative:true,behaviorRequired:false,visualUsed:false,adapterUsed:false,budgetExhausted:false})).toBe(1);
    expect(escalationLevel({historyCompatible:false,semanticAuthoritative:false,behaviorRequired:true,visualUsed:false,adapterUsed:false,budgetExhausted:false})).toBe(2);
    expect(escalationLevel({historyCompatible:false,semanticAuthoritative:false,behaviorRequired:false,visualUsed:true,adapterUsed:false,budgetExhausted:false})).toBe(3);
    expect(escalationLevel({historyCompatible:false,semanticAuthoritative:false,behaviorRequired:false,visualUsed:false,adapterUsed:true,budgetExhausted:false})).toBe(4);
    expect(escalationLevel({historyCompatible:false,semanticAuthoritative:false,behaviorRequired:false,visualUsed:false,adapterUsed:false,budgetExhausted:true})).toBe(5);
  });
  it("bounds every phase by the remaining transaction budget",()=>{const budget=new PraxisBudget(1_000);expect(budget.forPhase("grounding")).toBeLessThanOrEqual(320);expect(budget.forPhase("effectVerification")).toBeLessThanOrEqual(160);expect(budget.remaining()).toBeLessThanOrEqual(1_000);});
  it("emits bounded metric dimensions",()=>{const values:Array<{name:string;value:number}>=[];const metrics=new PraxisMetrics(metric=>values.push(metric));metrics.escalation(3,{risk:"ordinary"});metrics.timing("grounding",12);expect(values).toMatchObject([{name:"praxis.escalation",value:3},{name:"praxis.phase.duration_ms",value:12}]);});
});
