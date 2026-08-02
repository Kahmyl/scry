import { describe,expect,it,vi } from "vitest";
import { OrchestrationService } from "../src/orchestration.service.js";
import { MissionService } from "../src/mission.service.js";

describe("Mission lifecycle regression",()=>{
  it("orders Mission cards by creation time rather than recent activity",async()=>{
    const queries:string[]=[];
    const database={query:vi.fn(async(text:string)=>{queries.push(text);return text.includes("SELECT 1 FROM projects")?{rowCount:1,rows:[{}]}:{rowCount:0,rows:[]};})};
    await new MissionService(database as never).list({kind:"service",subject:"scry-service"},"11111111-1111-4111-8111-111111111111");
    expect(queries.at(-1)).toContain("ORDER BY m.created_at DESC,m.id DESC");
    expect(queries.at(-1)).not.toContain("ORDER BY m.updated_at DESC");
  });

  it("keeps terminal candidate outcomes awaiting evidence instead of declaring Objective failure",async()=>{
    const queries:string[]=[];
    const client={query:vi.fn(async(text:string)=>{queries.push(text);if(text.includes("SELECT o.id,o.dependencies"))return{rowCount:0,rows:[]};if(text.includes("SELECT x.objective_id,r.id run_id"))return{rowCount:0,rows:[]};return{rowCount:0,rows:[]};})};
    const service=new OrchestrationService({} as never);
    await (service as unknown as {reconcileMission(c:unknown,id:string):Promise<void>}).reconcileMission(client,"22222222-2222-4222-8222-222222222222");
    expect(queries[0]).toContain("EXISTS(SELECT 1 FROM accepted_evidence");
    expect(queries[0]).toContain("SET state='passed'");
    expect(queries[1]).toContain("SET status='running',resume_pointer=NULL");
    expect(queries[2]).toContain("WHEN r.state='queued' THEN 'queued'");
    expect(queries[2]).toContain("ELSE 'awaiting_evidence'");
    expect(queries[2]).toContain("x.state NOT IN ('passed','failed','blocked','cancelled')");
    expect(queries[3]).toContain("SET status='pending',conclusion=NULL");
    expect(queries.join("\n")).not.toContain("Execution failed and requires review");
  });

  it("requires continuation when related non-terminal work already exists",async()=>{
    let requestHash="";
    const query=vi.fn(async(text:string,values:unknown[]=[])=>{
      if(text.includes("SELECT 1 FROM projects"))return{rowCount:1,rows:[{}]};
      if(text.includes("INSERT INTO idempotency_records")){requestHash=String(values[2]);return{rowCount:1,rows:[]};}
      if(text.includes("SELECT request_hash"))return{rowCount:1,rows:[{requestHash,response:null}]};
      if(text.includes("SELECT id,title,status,resume_pointer"))return{rowCount:1,rows:[{id:"33333333-3333-4333-8333-333333333333",title:"Existing",status:"planning",resumePointer:null}]};
      return{rowCount:0,rows:[]};
    });
    const database={transaction:(work:(client:{query:typeof query})=>unknown)=>work({query}),query};
    await expect(new MissionService(database as never).create({kind:"service",subject:"scry-service"},"11111111-1111-4111-8111-111111111111",{title:"Existing",originalInstruction:"Continue this work",instructionSnapshot:"Continue this work",provider:"codex",idempotencyKey:"mission-regression-1"})).rejects.toMatchObject({response:{code:"MISSION_CONTINUATION_REQUIRED"}});
  });

  it("writes the final completed state into an immutable report snapshot",async()=>{
    const responses=[{rows:[{title:"Mission",originalInstruction:"Test",status:"blocked"}]},{rows:[]},{rows:[{count:0}]}];
    const query=vi.fn(async()=>({rowCount:0,...responses.shift()}));
    const snapshot=await (new MissionService({} as never) as unknown as {buildReportSnapshot(q:unknown,id:string,conclusion:string,journey:string[],actions:string[],status:string):Promise<{mission:{status:string}}>}).buildReportSnapshot(query,"44444444-4444-4444-8444-444444444444","Passed",["Done"],[],"completed");
    expect(snapshot.mission.status).toBe("completed");
  });
});
