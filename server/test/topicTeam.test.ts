import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import type {FastifyInstance} from "fastify";
const calls=vi.hoisted(()=>({chat:[] as any[],slots:[] as any[],delivery:"idle" as "idle"|"queued"|"busy"}));
vi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<any>(),runRoleInProcess:async()=>({runId:"mock",completion:Promise.resolve()}),deliverTopicToWork:async()=>calls.delivery}));
vi.mock("../src/runtime/PiRuntimeAdapter.js",async original=>({...await original<any>(),startChatRun:async(input:any)=>{calls.chat.push(input);return {sessionId:"topic-session",text:"Обсудили"};}}));
// Сообщение в теме адресовано роли с рабочим этапом — это разговорный ход
// этапа (startSlotConversation, режим чтения), а не рабочий запуск чата.
vi.mock("../src/runtime/slotConversation.js",async original=>({...await original<any>(),startSlotConversation:async(input:any)=>{calls.slots.push(input);return {sessionId:"slot-session",text:"Обсудили"};}}));
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {ensureTaskRoom,topicContext} from "../src/lib/projectTopics.js";
import {canPlanSubtaskBecomeReady,startPlanSubtaskRun,unlockDependencyPlans} from "../src/runtime/planSubtaskAdmission.js";
import {completePlanFinalReview,ensurePlanFinalReviewer} from "../src/runtime/planReviewLifecycle.js";
import {seedRoleAccounts,demoteSeededOwner} from "./helpers/seedOwner.js";

describe("Команда в теме задачи",()=>{
 let app:FastifyInstance,auth:any,taskId:string,planId:string,topicId:string;
 beforeAll(async()=>{
  app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);
  const r=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"TeamOwner",email:`team-${Date.now()}@test`,password:"password123"}})).json();
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(r.user.id);auth={authorization:`Bearer ${r.token}`};
  const project=(await app.inject({method:"POST",url:"/api/projects",headers:auth,payload:{name:"Командная тема"}})).json();
  taskId=(await app.inject({method:"POST",url:"/api/tasks",headers:auth,payload:{title:"Исследование",project_id:project.id}})).json().task.id;
  const p=(await app.inject({method:"POST",url:`/api/tasks/${taskId}/collaboration-plans`,headers:auth,payload:{profile:"manual",rationale:"Обсуждение",nodes:[{slot_key:"research",role_key:"researcher",expected_result:"Документ фактов"},{slot_key:"analysis",role_key:"analyst",expected_result:"Выводы"}],edges:[{from_slot_key:"research",to_slot_key:"analysis",start_condition:"accepted"}]}})).json();planId=p.plan?.id??p.id;
  const approved=await app.inject({method:"POST",url:`/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,headers:auth});expect(approved.statusCode).toBe(200);
  topicId=(db.prepare("SELECT id FROM chats WHERE task_id=? AND room_kind='task'").get(taskId) as any).id;
 });
 afterAll(async()=>{await app.close();});
 it("утверждение включает участников; контекст описывает обязанности и зависимости",()=>{
  const ids=(db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(topicId) as any[]).map(r=>r.member_id);
  expect(ids).toContain("role_researcher");expect(ids).toContain("role_analyst");
  expect(ensureTaskRoom(taskId)).toBe(topicId);
  expect(topicContext(taskId)).toContain("research → analysis");expect(topicContext(taskId)).toContain("Документ фактов");
 });
 it("присоединившийся Критик включается в ту же тему",()=>{
  ensurePlanFinalReviewer(planId,taskId);
  expect(db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id='role_critic_verifier'").get(topicId)).toBeTruthy();
 });
 it("свободный участник отвечает только в режиме чтения",async()=>{
  calls.delivery="idle";calls.chat=[];calls.slots=[];
  const r=await app.inject({method:"POST",url:`/api/chats/${topicId}/messages`,headers:auth,payload:{text:"@analyst Уточни формат вывода"}});expect(r.statusCode).toBe(200);
  await vi.waitFor(()=>expect(calls.slots.length).toBe(1));
  // Разговорный ход этапа — чтение; рабочего запуска чата (startChatRun) нет.
  expect(calls.chat).toHaveLength(0);
  expect(calls.slots[0]).toMatchObject({role:"analyst",taskId,chatId:topicId});
 });
 it("занятому участнику не создаётся второй чатовый запуск",async()=>{
  calls.delivery="queued";calls.chat=[];
  await app.inject({method:"POST",url:`/api/chats/${topicId}/messages`,headers:auth,payload:{text:"@researcher Новый вопрос"}});
  expect(calls.chat).toHaveLength(0);
 });
 it("согласование допускается заранее, зависимости блокируют только исполнение",async()=>{
  const createTask=async(title:string)=>(await app.inject({method:"POST",url:"/api/tasks",headers:auth,payload:{title}})).json().task.id;
  const blocker=await createTask("Предшественник"),child=await createTask("Зависимая работа");
  db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,'completed')").run(child,blocker);
  const created=(await app.inject({method:"POST",url:`/api/tasks/${child}/collaboration-plans`,headers:auth,payload:{profile:"manual",rationale:"Зависимость",nodes:[{slot_key:"work",role_key:"researcher",expected_result:"Документ"}],edges:[]}})).json();
  const id=created.plan?.id??created.id;
  const approve=()=>app.inject({method:"POST",url:`/api/tasks/${child}/collaboration-plans/${id}/approve`,headers:auth});
  expect((await approve()).statusCode).toBe(200);
  const waiting=db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id=?").get(id) as any;
  expect(waiting.agent_state).toBeNull();
  db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(blocker);
  expect(canPlanSubtaskBecomeReady(waiting)).toBe(false);
  db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(blocker);
  await unlockDependencyPlans();
  const row=db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id=?").get(id) as any;
  db.prepare("UPDATE attempts SET ended_at=datetime('now'),outcome='interrupted' WHERE subtask_id=? AND ended_at IS NULL").run(row.id);
  db.prepare("UPDATE subtasks SET agent_state=NULL,current_attempt_id=NULL WHERE id=?").run(row.id);
  db.prepare("UPDATE tasks SET status='active',agent_state=NULL WHERE id=?").run(blocker);
  expect(canPlanSubtaskBecomeReady(row)).toBe(false);
  const count=()=>(db.prepare("SELECT COUNT(*) n FROM attempts WHERE subtask_id=?").get(row.id) as any).n;
  const before=count();
  expect((await startPlanSubtaskRun(row.id,"role_researcher")).ok).toBe(false);
  expect(count()).toBe(before);
  db.prepare("UPDATE task_dependencies SET policy='review' WHERE task_id=?").run(child);
  db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(blocker);
  expect(canPlanSubtaskBecomeReady(row)).toBe(true);
  await unlockDependencyPlans();
  expect((db.prepare("SELECT agent_state FROM subtasks WHERE id=?").get(row.id) as any).agent_state).toBe("in_progress");
 });

 it("изменения графа сохраняют один снимок на версию, включая маршрут Критика",()=>{
  // Снимки плана живут в plan_event_journal, не в истории чата (миграция
  // 096, «Plan snapshots belong to the plan journal, never to chat history»).
  const count=()=>(db.prepare("SELECT COUNT(*) n FROM plan_event_journal WHERE plan_id=?").get(planId) as any).n;
  const before=count();ensureTaskRoom(taskId);ensureTaskRoom(taskId);expect(count()).toBe(before);
  expect(()=>db.transaction(()=>{
    db.prepare("UPDATE task_collaboration_plans SET version=version+1 WHERE id=?").run(planId);
    ensureTaskRoom(taskId);throw new Error("rollback");
  })()).toThrow("rollback");
  expect(count()).toBe(before);
  completePlanFinalReview(taskId,"role_critic_verifier","changes_requested","Нужны источники",["research"]);
  expect(count()).toBe(before+1);
  const event=db.prepare("SELECT version,snapshot FROM plan_event_journal WHERE plan_id=? ORDER BY version DESC LIMIT 1").get(planId) as any;
  const snapshot=JSON.parse(event.snapshot);
  const revised=snapshot.nodes.find((n:any)=>n.rework_of_key==="research");
  expect(revised).toBeTruthy();
  expect(String(revised.added_reason)).toContain("Нужны источники");
  expect(snapshot.edges.some((e:any)=>e.to_slot_key===revised.slot_key && e.from_slot_key.startsWith("final_review_"))).toBe(true);
  ensureTaskRoom(taskId);expect(count()).toBe(before+1);
 });

 it("auto_template утверждается владельцем и гасит идущую подготовку",async()=>{
  // Решение владельца 07.10.2026 «нет блоков для меня, моё слово главное»:
  // origin узла плана — это метка происхождения, а не «можно ли
  // утверждать». Правка в lib/preparationGate.ts и код approve гонят
  // именно эту семантику: готовит план кто угодно, а право утвердить —
  // у владельца. Утверждение гасит идущую подготовку и снимает
  // ожидающий вопрос модели.
  const projectId=(db.prepare("SELECT project_id FROM tasks WHERE id=?").get(taskId) as any).project_id;
  const id=(await app.inject({method:"POST",url:"/api/tasks",headers:auth,payload:{title:"Подготовка в очереди",project_id:projectId}})).json().task.id;
  const created=(await app.inject({method:"POST",url:`/api/tasks/${id}/collaboration-plans`,headers:auth,payload:{profile:"manual",rationale:"Шаблон",nodes:[{slot_key:"work",role_key:"researcher",expected_result:"Документ"}],edges:[]}})).json();
  const plan=created.plan?.id??created.id;
  db.prepare("UPDATE task_collaboration_plan_nodes SET origin='auto_template' WHERE plan_id=?").run(plan);
  // Запускаем «идущую подготовку», чтобы проверить, что approve её гасит.
  // Триггер enqueue_new_task_preparation уже завёл джобу на input_version=1;
  // поднимаем её, чтобы approve точно встретил идущий «running».
  const iv=(db.prepare("SELECT COALESCE(MAX(input_version),0)+1 AS v FROM task_preparation_jobs WHERE task_id=?").get(id) as any).v;
  db.prepare(
    "INSERT INTO task_preparation_jobs (task_id, input_version, snapshot, attempts, status, available_at) VALUES (?, ?, '{}', 0, 'running', datetime('now'))",
  ).run(id, iv);
  const approve=()=>app.inject({method:"POST",url:`/api/tasks/${id}/collaboration-plans/${plan}/approve`,headers:auth});
  expect((await approve()).statusCode).toBe(200);
  // Никакой подготовки не осталось: идущая погашена.
  const running=(db.prepare("SELECT COUNT(*) n FROM task_preparation_jobs WHERE task_id=? AND status IN ('queued','running')").get(id) as any).n;
  expect(running).toBe(0);
 });

});
