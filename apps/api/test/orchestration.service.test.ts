import { describe,expect,it } from "vitest";
import { OrchestrationService } from "../src/orchestration.service.js";

describe("Orchestration dependency authority",()=>{
  const service=new OrchestrationService({} as never);
  const validate=(rows:Array<{id:string;dependencies:string[]}>)=>(service as any).assertAcyclic(rows);
  it("accepts independent and sequential branches",()=>expect(()=>validate([{id:"a",dependencies:[]},{id:"b",dependencies:[]},{id:"c",dependencies:["a"]}])).not.toThrow());
  it("rejects cycles",()=>expect(()=>validate([{id:"a",dependencies:["b"]},{id:"b",dependencies:["a"]}])).toThrowError(expect.objectContaining({response:expect.objectContaining({code:"OBJECTIVE_DEPENDENCY_CYCLE"})})));
  it("rejects missing dependency identities",()=>expect(()=>validate([{id:"a",dependencies:["missing"]}])).toThrowError(expect.objectContaining({response:expect.objectContaining({code:"OBJECTIVE_DEPENDENCY_MISSING"})})));
});
