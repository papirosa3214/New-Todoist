import {beforeAll,beforeEach,afterEach,it,expect,vi} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {evaluateJev,saveJevSettings,resetJevSettings} from "../src/lib/jev.js";
import {selectSkillsByJev} from "../src/lib/memorySkillsJev.js";
import {pickRolesForSubtasksByJev} from "../src/lib/subtaskRoleJev.js";
import {allRoles} from "../src/roleRouting.js";
beforeAll(()=>{migrate();runMigrations();});
beforeEach(()=>{resetJevSettings();saveJevSettings({apiKey:"fixture-jev-key",skillsEnabled:true,subtaskRoleEnabled:true});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
const q={check:{type:"noul" as const,instructions:"Useful?"}};
const respond=(answers:unknown)=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({model:"jev-1.14.0",answers}))));
it.each([-0.1,1.1,"0.8"])("rejects invalid noul %s before consumers use it",async(noul)=>{
 respond({check:{type:"noul",noul}});expect(await evaluateJev("x",q)).toBeNull();
});
it("rejects non-finite confidence supplied by a broken transport",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,text:async()=>'{"model":"jev-1.14.0","answers":{"pick":{"type":"choice","choice":"yes","confidence":1e999,"probabilities":{"yes":1}}}}'})));
 expect(await evaluateJev("x",{pick:{type:"choice",instructions:"Pick",criteria:{yes:"Yes"}}})).toBeNull();
});
it("records the actual responding model",async()=>{
 respond({check:{type:"noul",noul:0.8}});const result=await evaluateJev("x",q);
 const row=db.prepare("SELECT details FROM context_operations WHERE id=?").get(result!.observationId) as any;
 expect(JSON.parse(row.details)).toContain("model: jev-1.14.0");
});
it("ends waiting when fetch ignores abort",async()=>{
 vi.useFakeTimers();let settled=false;
 vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>{})));
 const pending=evaluateJev("x",q,{timeoutMs:500}).then(result=>{settled=true;return result;});
 await vi.advanceTimersByTimeAsync(501);expect(settled).toBe(true);expect(await pending).toBeNull();
});
it("includes body reading in the deadline",async()=>{
 vi.useFakeTimers();let settled=false;
 vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,text:()=>new Promise(()=>{})})));
 const pending=evaluateJev("x",q,{timeoutMs:500}).then(result=>{settled=true;return result;});
 await vi.advanceTimersByTimeAsync(501);expect(settled).toBe(true);expect(await pending).toBeNull();
});
it("keeps explicitly required skills even when relevance is low",async()=>{
 const skills=Array.from({length:7},(_,i)=>({name:"s"+i,description:"skill "+i}));
 respond(Object.fromEntries(skills.map((s,i)=>["s"+i,{type:"noul",noul:i===1?0.9:0.01}])));
 const selected=await selectSkillsByJev({title:"work",description:null},skills,["s0"]);
 expect(selected?.has("s0")).toBe(true);expect(selected?.has("s1")).toBe(true);expect(selected?.has("s2")).toBe(false);
});
it("does not delegate on a partial answer missing separate",async()=>{
 const role=allRoles().filter(r=>r.enabled)[0];
 respond({role_0:{type:"choice",choice:role.key,confidence:0.9,probabilities:{[role.key]:0.9}}});
 expect((await pickRolesForSubtasksByJev({title:"work",description:null},[{id:"s",title:"work"}])).size).toBe(0);
});
it("preserves responding model after a scenario updates its observation",async()=>{
 const skills=Array.from({length:7},(_,i)=>({name:"s"+i,description:"skill"}));
 respond(Object.fromEntries(skills.map((_,i)=>["s"+i,{type:"noul",noul:0.9}])));
 await selectSkillsByJev({title:"work",description:null},skills);
 const row=db.prepare("SELECT details FROM context_operations WHERE scenario=? ORDER BY rowid DESC LIMIT 1").get("skills") as any;
 expect(JSON.parse(row.details)).toContain("model: jev-1.14.0");
});
it("does not spend a request when every skill is mandatory",async()=>{
 const skills=Array.from({length:7},(_,i)=>({name:"s"+i,description:"skill"}));
 respond(Object.fromEntries(skills.map((_,i)=>["s"+i,{type:"noul",noul:0.9}])));
 expect(await selectSkillsByJev({title:"work",description:null},skills,skills.map(s=>s.name))).toBeNull();
 expect(fetch).not.toHaveBeenCalled();
});
