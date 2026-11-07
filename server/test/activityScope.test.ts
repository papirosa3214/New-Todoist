import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Activity separated by executor slot", () => {
  let app: FastifyInstance, token: string, owner: string, agent: string, task: string;
  beforeAll(async () => {
    app = await buildApp();
    const o = (await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"OwnerScope",email:"owner@scope.test",password:"password123"}})).json();
    owner=o.token;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(o.user.id);
    const a = (await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"BuilderScope",email:"builder@scope.test",password:"password123"}})).json();
    token=a.token;agent=a.user.id;db.prepare("UPDATE users SET type='ai' WHERE id=?").run(agent);
    task=(await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:`Bearer ${owner}`},payload:{title:"Parallel",assignee_id:agent}})).json().task.id;
    markReadyForPickup(task);
    expect((await app.inject({method:"POST",url:`/api/tasks/${task}/claim`,headers:{authorization:`Bearer ${token}`},payload:{}})).statusCode).toBe(200);
    for(const id of ["scope-server","scope-web"]) db.prepare("INSERT INTO subtasks(id,task_id,title,agent_id,agent_state) VALUES(?,?,?,?,'in_progress')").run(id,task,id,agent);
  });
  afterAll(async()=>{await app.close()});
  async function post(id?:string) {return app.inject({method:"POST",url:`/api/tasks/${task}/activity`,headers:{authorization:`Bearer ${token}`},payload:{kind:"read",target:"src/sample.ts",subtask_id:id}})}
  async function get() {return (await app.inject({method:"GET",url:`/api/tasks/${task}/activity`,headers:{authorization:`Bearer ${owner}`}})).json()}
  it("parallel slots of the same role have separate counters, actions and author",async()=>{
    expect((await post("scope-server")).statusCode).toBe(200);
    await post("scope-server");await post("scope-web");await post();
    const r=await get();expect(r.total).toBe(4);
    expect(r.by_subtask["scope-server"].total).toBe(2);expect(r.by_subtask["scope-web"].total).toBe(1);
    expect(r.by_subtask["scope-server"].actions).toHaveLength(2);
    expect(r.by_subtask["scope-web"].actions[0]).toMatchObject({actor:"BuilderScope",actor_id:agent,subtask_id:"scope-web"});
  });
  it("rejects nonexistent and foreign slots",async()=>{expect((await post("foreign-slot")).statusCode).toBe(400)});
  it("slot totals stay exact after the shared ring drops old actions",async()=>{
    for(let i=0;i<501;i++) expect((await post("scope-server")).statusCode).toBe(200);
    const r=await get();expect(r.total).toBe(505);expect(r.actions).toHaveLength(500);
    expect(r.by_subtask["scope-server"].total).toBe(503);expect(r.by_subtask["scope-web"].total).toBe(1);
  });
});
