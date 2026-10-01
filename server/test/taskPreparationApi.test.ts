import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {demoteSeededOwner,seedRoleAccounts} from "./helpers/seedOwner.js";
import {submitOwnerTaskText} from "../src/lib/ownerDraft.js";
vi.mock("../src/runtime/inProcessRun.js", async importOriginal=>({...await importOriginal<typeof import("../src/runtime/inProcessRun.js")>(),runRoleInProcess:async()=>({runId:"test-run",completion:Promise.resolve()})}));
const stream=(key:string,title:string,role:string,deps:string[]=[])=>({key,title,role,result:`Готов: ${title}`,depends_on:deps,parallel_with:[]});
const fixture=()=>({title:"Общий результат",description:"Два проверяемых результата",result:"Проверенная реализация",question:null,subtasks:[],children:[],due_date:null,priority:4,project:null,role:null,preparation:{intent:"executable_task",representation:"role_plan",reason:"Разработка и проверка одного результата",question:null,workstreams:[stream("build","Реализация","builder"),stream("verify","Проверка","qa",["build"])]}});
describe("общая подготовка через реальные серверные адаптеры",()=>{
  let app:Awaited<ReturnType<typeof buildApp>>,owner:string,auth:string;
  let response:any;
  const requestModel=vi.fn(async()=>new Response(JSON.stringify({message:{content:JSON.stringify(response)}}),{status:200}));
  beforeAll(async()=>{
    app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);
    const reg=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"Preparation owner",email:"preparation@test",password:"password123"}})).json();
    owner=reg.user.id;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);auth=`Bearer ${reg.token}`;
  });
  beforeEach(()=>{response=fixture();requestModel.mockClear();vi.stubGlobal("fetch",requestModel);});
  afterAll(async()=>{vi.unstubAllGlobals();await app.close();});
  const prepare=(text="Реализуй и проверь результат")=>app.inject({method:"POST",url:"/api/task-preparation/prepare",headers:{authorization:auth},payload:{text,source_record_id:"request-1"}});
  it("анализ не пишет БД, повторный запрос не создаёт карточек и использует один вызов",async()=>{
    const before=(db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
    const first=await prepare(); expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({schema_version:1,status:"recommendation_only",source_record_id:"request-1",intent:"executable_task"});
    expect(first.json().card.subtasks).toEqual(["Реализация","Проверка"]);expect(requestModel).toHaveBeenCalledTimes(1);
    await prepare();expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(before);
  });
  it("вопрос остаётся без карточки во всех адаптерах создания",async()=>{
    response={preparation:{intent:"informational_question",question:"Почему так?"}};
    expect((await prepare("Почему так?")).json().card).toBeNull();
    const old=await app.inject({method:"POST",url:"/api/ai/structure-task",headers:{authorization:auth},payload:{text:"Почему так?"}});expect(old.statusCode).toBe(422);
    await expect(submitOwnerTaskText("Почему так?",owner,"automatic")).rejects.toThrow("Почему так?");
    const imported=await app.inject({method:"POST",url:"/api/ai/structure-draft",headers:{authorization:auth},payload:{text:"Почему система именно так устроена?"}});expect(imported.statusCode).toBe(422);
  });
  it("автоматический intake сохраняет план черновиком, approve использует те же подзадачи",async()=>{
    const result=await submitOwnerTaskText("Реализуй и проверь",owner,"automatic");
    expect(result.requiresPlanApproval).toBe(true);expect(result.dispatched).toBe(0);expect(result.childIds).toEqual([]);
    const task=db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(result.parentId) as any;expect(task.ready_for_pickup).toBe(0);
    const subs=db.prepare("SELECT id FROM subtasks WHERE task_id=? ORDER BY position").all(result.parentId) as any[];
    const plan=db.prepare("SELECT id,status FROM task_collaboration_plans WHERE task_id=?").get(result.parentId) as any;expect(plan.status).toBe("draft");
    const approved=await app.inject({method:"POST",url:`/api/tasks/${result.parentId}/collaboration-plans/${plan.id}/approve`,headers:{authorization:auth}});expect(approved.statusCode).toBe(200);
    expect(db.prepare("SELECT id FROM subtasks WHERE task_id=? ORDER BY position").all(result.parentId)).toEqual(subs);
  });
  it("внутренняя роль передаёт общий контракт в обычное создание карточки",async()=>{
    const card=(await prepare()).json().card;
    const roleAuth=`Bearer ${app.jwt.sign({id:"role_builder"})}`;
    const created=await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:roleAuth},payload:{title:card.title,description:card.description,subtasks:card.subtasks,preparation:card.preparation}});
    expect(created.statusCode).toBe(200);
    const plan=db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id=?").get(created.json().task.id) as any;expect(plan.status).toBe("draft");
  });
  it("не записывает половину карточки при несовпадении результатов",async()=>{
    const card=(await prepare()).json().card;
    const before=(db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
    const created=await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:auth},payload:{title:card.title,subtasks:["Чужая подзадача"],preparation:card.preparation}});
    expect(created.statusCode).toBe(400);expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(before);
  });
  it("чек-лист сохраняет выбранную роль, критерий результата и уточнение",async()=>{
    response.preparation.representation="checklist";
    response.preparation.workstreams=[stream("write","Инструкция","builder")];
    response.role=null; response.question="Какой формат инструкции нужен?";
    const card=(await prepare()).json().card;
    const created=await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:auth},payload:{title:card.title,description:card.description,subtasks:card.subtasks,preparation:card.preparation}});
    expect(created.statusCode).toBe(200);
    const row=db.prepare("SELECT machine_selected_role,description,needs_clarification FROM tasks WHERE id=?").get(created.json().task.id) as any;
    expect(row.machine_selected_role).toBe("builder");expect(row.needs_clarification).toBe(1);expect(row.description).toContain("Готов: Инструкция");
  });
  it("устаревший каталог и слишком большой ввод дают отказ до записи",async()=>{
    response.project="Проект, которого нет";
    expect((await prepare()).json().question).toMatch(/проект/);
    const bad=await app.inject({method:"POST",url:"/api/task-preparation/prepare",headers:{authorization:auth},payload:{text:"x".repeat(12001)}});expect(bad.statusCode).toBe(400);
    const unauthorized=await app.inject({method:"POST",url:"/api/task-preparation/prepare",payload:{text:"Сделай"}});expect(unauthorized.statusCode).toBe(401);
  });
  it("не даёт утвердить неизвестную совместимость",async()=>{
    response.preparation.workstreams[1].depends_on=[];
    const result=await submitOwnerTaskText("Два результата",owner,"automatic");expect(result.questions.length).toBeGreaterThan(0);
    const plan=db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=?").get(result.parentId) as any;
    const approved=await app.inject({method:"POST",url:`/api/tasks/${result.parentId}/collaboration-plans/${plan.id}/approve`,headers:{authorization:auth}});expect(approved.statusCode).toBe(409);
  });
});
