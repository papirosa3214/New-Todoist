import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {createLinearPreview,commitLinearPreview,mergeLinearFields} from "../src/lib/linearImport.js";
import type {LinearIssue,LinearSnapshot} from "../src/lib/linearSource.js";
import {fetchLinearSnapshot,listLinearIssues} from "../src/lib/linearSource.js";
import crypto from "node:crypto";
vi.mock("../src/lib/linearSource.js", async original=>({...await original<any>(),fetchLinearSnapshot:vi.fn(),listLinearIssues:vi.fn()}));
const uuid=()=>crypto.randomUUID();
const issue=(id=uuid(),parent:string|null=null):LinearIssue=>({id,identifier:"TF-1",title:"Внешняя задача",description:"**Описание**",url:"https://linear.app/test/issue/TF-1",priority:2,dueDate:"2026-10-10",createdAt:"2026-10-01T10:00:00Z",updatedAt:"2026-10-01T11:00:00Z",archivedAt:null,parent:parent?{id:parent}:null,state:{id:"state",name:"In Progress",type:"started"},children:[],labels:[],comments:[],history:[],attachments:[],documents:[],relations:[],inverseRelations:[],assignee:{id:"outside",name:"Внешний агент"},project:{id:"outside-project",name:"Внешний проект"},team:{id:"team",name:"Команда"}});
const snapshot=(issues:LinearIssue[]):LinearSnapshot=>({workspace:{id:"workspace",name:"Linear workspace"},selected_ids:[issues[0].id],issues,fetched_at:new Date().toISOString()});
describe("Linear import uses existing task semantics",()=>{
 let app:Awaited<ReturnType<typeof buildApp>>,owner:string,token:string,member:string;
 beforeAll(async()=>{app=await buildApp();for(const role of ["owner","member"]){const r=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:role,email:`${uuid()}@linear.test`,password:"password123"}})).json();if(role==="owner"){owner=r.user.id;token=r.token;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);}else member=r.token;}});
 afterAll(async()=>{await app.close();});
 const auth=()=>({authorization:`Bearer ${token}`});
 it("preview does not create tasks, child means child card, never execution step",()=>{
  const root=issue(),child=issue(undefined,root.id);root.children=[{id:child.id}];
  const source=snapshot([child,root]);source.selected_ids=[child.id];
  const before=(db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n;
  const p=createLinearPreview(owner,source,null);expect(p.items).toHaveLength(2);expect(p.items.find(i=>i.id===root.id)?.reason).toBe("hierarchy");
  expect((db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n).toBe(before);
  const r=commitLinearPreview(owner,p.preview_id);const rootId=r.task_ids.find((i:any)=>i.source_id===root.id).task_id,childId=r.task_ids.find((i:any)=>i.source_id===child.id).task_id;
  expect(db.prepare("SELECT parent_id,ready_for_pickup,assignee_id FROM tasks WHERE id=?").get(childId)).toEqual({parent_id:rootId,ready_for_pickup:0,assignee_id:null});
  expect(db.prepare("SELECT * FROM subtasks WHERE task_id=?").all(rootId)).toEqual([]);
  expect(db.prepare("SELECT * FROM task_collaboration_plans WHERE task_id=?").all(rootId)).toEqual([]);
 });
 it("repeat confirmation and new preview keep card and history IDs stable",()=>{
  const root=issue();root.comments=[{id:uuid(),body:"Результат внешнего агента",createdAt:root.createdAt,user:{name:"Внешний"}}];root.history=[{id:uuid(),createdAt:root.createdAt,actor:{name:"Агент"},fromTitle:"Старое",toTitle:root.title}];root.labels=[{id:uuid(),name:"Из Linear",color:"#123456"}];
  const source=snapshot([root]),p=createLinearPreview(owner,source,null),first=commitLinearPreview(owner,p.preview_id);
  expect(commitLinearPreview(owner,p.preview_id)).toEqual(first);
  const comments=db.prepare("SELECT id,text FROM comments WHERE task_id=? ORDER BY id").all(first.task_ids[0].task_id);
  const second=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);
  expect(second.created).toBe(0);expect(second.task_ids).toEqual(first.task_ids);
  expect(db.prepare("SELECT id,text FROM comments WHERE task_id=? ORDER BY id").all(first.task_ids[0].task_id)).toEqual(comments);
  expect(JSON.stringify(comments)).toContain("Внешний");expect(JSON.stringify(comments)).toContain("Результат внешнего агента");
  expect(db.prepare("SELECT COUNT(*) n FROM task_labels WHERE task_id=?").get(first.task_ids[0].task_id)).toEqual({n:1});
 });
 it("three-way updates preserve local edits while applying untouched remote fields",()=>{
  const root=issue(),source=snapshot([root]);const task=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id).task_ids[0].task_id;
  db.prepare("UPDATE tasks SET title=? WHERE id=?").run("Моя правка",task);root.title="Новое внешнее название";root.description="Новое описание";
  const p=createLinearPreview(owner,source,null);expect(p.items[0].conflicts).toContain("title");commitLinearPreview(owner,p.preview_id);
  expect(db.prepare("SELECT title,description FROM tasks WHERE id=?").get(task)).toEqual({title:"Моя правка",description:"Новое описание"});
 });
 it("local changes after preview require another preview rather than overwriting",()=>{
  const root=issue(),source=snapshot([root]);const task=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id).task_ids[0].task_id;
  const p=createLinearPreview(owner,source,null);db.prepare("UPDATE tasks SET title='После просмотра' WHERE id=?").run(task);
  expect(()=>commitLinearPreview(owner,p.preview_id)).toThrow(/изменились после/);
 });
 it("imports blocking relation as completed dependency and rolls back a cycle",()=>{
  const a=issue(),b=issue(),relation={id:uuid(),type:"blocks",issue:{id:a.id,identifier:"A",url:a.url},relatedIssue:{id:b.id,identifier:"B",url:b.url}};a.relations=[relation];b.inverseRelations=[relation];
  const source=snapshot([a,b]),first=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);const ai=first.task_ids[0].task_id,bi=first.task_ids[1].task_id;
  expect(db.prepare("SELECT policy FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?").get(bi,ai)).toEqual({policy:"completed"});
  const c=issue(),d=issue();c.relations=[{id:uuid(),type:"blocks",issue:{id:c.id,identifier:"C"},relatedIssue:{id:d.id,identifier:"D"}}];d.relations=[{id:uuid(),type:"blocks",issue:{id:d.id,identifier:"D"},relatedIssue:{id:c.id,identifier:"C"}}];
  const p=createLinearPreview(owner,snapshot([c,d]),null),count=(db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n;
  expect(()=>commitLinearPreview(owner,p.preview_id)).toThrow(/цикл зависимостей/);expect((db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n).toBe(count);
 });
 it("preserves native dependencies and locally removed imported dependencies",()=>{
  const a=issue(),b=issue(),rel={id:uuid(),type:"blocks",issue:{id:a.id,identifier:"A"},relatedIssue:{id:b.id,identifier:"B"}};a.relations=[rel];const source=snapshot([a,b]);const r=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);
  db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(r.task_ids[1].task_id);
  commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);
  expect(db.prepare("SELECT * FROM task_dependencies WHERE task_id=?").all(r.task_ids[1].task_id)).toEqual([]);
 });
 it("rejects broken hierarchy, cycles and expired/foreign preview without writes",()=>{
  const a=issue(undefined,uuid());expect(()=>createLinearPreview(owner,snapshot([a]),null)).toThrow(/отсутствует родитель/);
  a.parent={id:a.id};expect(()=>createLinearPreview(owner,snapshot([a]),null)).toThrow(/Цикл/);
  a.parent=null;const p=createLinearPreview(owner,snapshot([a]),null);expect(()=>commitLinearPreview("u1",p.preview_id)).toThrow(/устарел/);
  db.prepare("UPDATE linear_import_previews SET expires_at=0 WHERE id=?").run(p.preview_id);expect(()=>commitLinearPreview(owner,p.preview_id)).toThrow(/устарел/);
 });
 it("active internal work keeps status, parent and role assignment",()=>{
  const a=issue(),source=snapshot([a]);const id=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id).task_ids[0].task_id;
  db.prepare("UPDATE tasks SET ready_for_pickup=1 WHERE id=?").run(id);a.state.type="completed";
  const p=createLinearPreview(owner,source,null);expect(p.items[0].conflicts.join()).toContain("Внутренняя работа");commitLinearPreview(owner,p.preview_id);expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(id) as any).status).toBe("active");
 });
 it("owner-only routes reject arbitrary payloads and use server snapshots",async()=>{
  for(const method of ["GET","POST"] as const){const res=await app.inject({method,url:method==="GET"?"/api/integrations/linear/issues":"/api/integrations/linear/preview",headers:{authorization:`Bearer ${member}`},...(method==="POST"?{payload:{issue_ids:[uuid()]}}:{})});expect(res.statusCode).toBe(403);}
  expect((await app.inject({method:"POST",url:"/api/integrations/linear/preview",headers:auth(),payload:{issue_ids:["query mutation"]}})).statusCode).toBe(422);
  const source=snapshot([issue()]);vi.mocked(fetchLinearSnapshot).mockResolvedValueOnce(source);const p=(await app.inject({method:"POST",url:"/api/integrations/linear/preview",headers:auth(),payload:{issue_ids:[source.issues[0].id]}})).json();
  const imported=await app.inject({method:"POST",url:"/api/integrations/linear/import",headers:auth(),payload:{preview_id:p.preview_id,issues:[{title:"Injected"}]}});expect(imported.statusCode).toBe(200);expect(imported.json().created).toBe(1);
  vi.mocked(listLinearIssues).mockResolvedValueOnce({workspace:source.workspace,issues:source.issues,cursor:null});expect((await app.inject({method:"GET",url:"/api/integrations/linear/issues",headers:auth()})).statusCode).toBe(200);
 });
 it("background preparation exposes a reviewed snapshot without creating cards",async()=>{
  const source=snapshot([issue()]);let finish!:(value:LinearSnapshot)=>void;
  vi.mocked(fetchLinearSnapshot).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const before=(db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n;
  const response=await app.inject({method:"POST",url:"/api/integrations/linear/preview",headers:auth(),payload:{issue_ids:[source.issues[0].id],async:true}});
  expect(response.statusCode).toBe(202);const id=response.json().job_id;
  expect((await app.inject({method:"GET",url:`/api/integrations/linear/previews/${id}`,headers:auth()})).json().status).toBe("loading");
  finish(source);await new Promise(resolve=>setImmediate(resolve));
  const ready=(await app.inject({method:"GET",url:`/api/integrations/linear/previews/${id}`,headers:auth()})).json();expect(ready.status).toBe("ready");expect(ready.preview.items).toHaveLength(1);
  expect((db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n).toBe(before);
  expect((await app.inject({method:"GET",url:`/api/integrations/linear/previews/${id}`,headers:{authorization:`Bearer ${member}`}})).statusCode).toBe(403);
 });
 it("background failures remain explicit and write no cards",async()=>{
  vi.mocked(fetchLinearSnapshot).mockRejectedValueOnce(new Error("secret transport detail"));
  const response=await app.inject({method:"POST",url:"/api/integrations/linear/preview",headers:auth(),payload:{issue_ids:[uuid()],async:true}});
  await new Promise(resolve=>setImmediate(resolve));
  const failed=(await app.inject({method:"GET",url:`/api/integrations/linear/previews/${response.json().job_id}`,headers:auth()})).json();expect(failed.status).toBe("failed");expect(failed.error).not.toContain("secret");expect(failed.preview).toBeNull();
 });
 it("restores a deliberately reimported deleted card with its source document",()=>{
  const root=issue();root.documents=[{id:uuid(),title:"План",createdAt:root.createdAt,content:"Документ внешнего агента",url:root.url,creator:{name:"Автор"}}];
  const source=snapshot([root]);const first=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);
  db.prepare("DELETE FROM comments WHERE task_id=?").run(first.task_ids[0].task_id);
  db.prepare("DELETE FROM task_events WHERE task_id=?").run(first.task_ids[0].task_id);
  db.prepare("DELETE FROM tasks WHERE id=?").run(first.task_ids[0].task_id);
  const restored=commitLinearPreview(owner,createLinearPreview(owner,source,null).preview_id);expect(restored.created).toBe(1);
  expect(JSON.stringify(db.prepare("SELECT text FROM comments WHERE task_id=?").all(restored.task_ids[0].task_id))).toContain("Документ внешнего агента");
 });
 it("merge does not call a local-only edit a remote conflict",()=>{const base:any={title:"old",description:null,priority:4,due_date:null,status:"active",parent_id:null};expect(mergeLinearFields({...base,title:"local"},base,base).conflicts).toEqual([]);});
});
