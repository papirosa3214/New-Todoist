import {beforeAll,it,expect} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {readJevEffectiveness,stepUsage} from "../src/lib/jevEffectiveness.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"jev-eff-"));
const now=new Date().toISOString();
function step(task:string,sub:string,outcome:string,tokens:number,scenarioStatus:string){
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run("eff-owner","O","eff@test","x","owner","human");
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,?,?)").run(task,"T","eff-owner");
 db.prepare("INSERT INTO subtasks(id,task_id,title) VALUES(?,?,?)").run(sub,task,"S");
 db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at,outcome) VALUES(?,?,?,?,datetime(\x27now\x27,\x27-10 minutes\x27),datetime(\x27now\x27),?)").run("a-"+sub,task,sub,"eff-owner",outcome);
 db.prepare("INSERT INTO context_operations(id,kind,scenario,task_id,subtask_id,started_at,status) VALUES(?,?,?,?,?,?,?)").run("o-"+sub,"jev","skills",task,sub,now,scenarioStatus);
 const dir=path.join(root,`${task}-builder-${sub}`);fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,"s.jsonl"),JSON.stringify({type:"message",message:{role:"assistant",usage:{totalTokens:tokens,cost:{total:tokens/1e6}}}})+"\n");
}
beforeAll(()=>{migrate();runMigrations();
 step("eff-t1","eff-s1","submitted",1000,"ok");
 step("eff-t2","eff-s2","error_loop",5000,"skipped");
});
it("токены шага считаются по файлам его сессии",()=>{
 expect(stepUsage("eff-t1","eff-s1",root)).toEqual({tokens:1000,costUsd:0.001});
});
it("шаги с JEV и без него идут в разные группы: блоки, токены, время",()=>{
 const skills=readJevEffectiveness("week",root).scenarios.find(s=>s.scenario==="skills")!;
 expect(skills.on).toMatchObject({steps:1,badShare:0,tokensPerStep:1000});
 expect(skills.off).toMatchObject({steps:1,badShare:1,tokensPerStep:5000});
 expect(skills.on.minutesPerStep).toBeGreaterThan(9);
});
