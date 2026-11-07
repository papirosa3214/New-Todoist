import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/lib/aiClient.js",async original=>({...await original<typeof import("../src/lib/aiClient.js")>(),callUnifiedAi:vi.fn()}));
vi.mock("../src/auth.js",()=>({authOrApiToken:async(req:any)=>{req.userId="test-owner";}}));
import Fastify from "fastify";
import {registerAiRoutes} from "../src/routes/ai.js";
import {callUnifiedAi} from "../src/lib/aiClient.js";
import {parseStructuredDraft,structureTaskDraft} from "../src/lib/taskStructure.js";
const fixture=()=>({title:"Исправить подтверждение сдачи",work:"Сервер принимает результат шага и запускает проверку.",result:"Сданный шаг проходит проверку без лишнего блока.",acceptance:"Сдать результат, убедиться в запуске ревью и доступности ответа владельца.",boundaries:"Не менять уже принятые результаты.",subtasks:["Исправить обработку сдачи","Проверить переход на ревью"],question:null,due_date:null,priority:null});
beforeEach(()=>{vi.mocked(callUnifiedAi).mockReset();});
describe("диктовка → оформленная постановка",()=>{
 it("работает без технического preparation и формирует четыре раздела",()=>{
  const d=parseStructuredDraft(JSON.stringify(fixture()));expect(d.title).toBe(fixture().title);expect(d.description.match(/^## /gm)).toHaveLength(4);expect(d.description).toContain(fixture().acceptance);expect(d.subtasks).toHaveLength(2);expect(d.priority).toBeNull();
 });
 it("не требует декоративных шагов и убирает повторы",()=>{const f=fixture();f.subtasks=[];expect(parseStructuredDraft(JSON.stringify(f)).subtasks).toEqual([]);f.subtasks=["Проверить","Проверить"];expect(parseStructuredDraft(JSON.stringify(f)).subtasks).toEqual(["Проверить"]);});
 it("сохраняет конкретное уточнение в описании для подготовки",()=>{const f={...fixture(),question:"В каком репозитории правим?"};expect(parseStructuredDraft(JSON.stringify(f)).description).toContain(f.question);});
 it("сохраняет явно заданные срок и приоритет",()=>{const f={...fixture(),due_date:"2026-10-10",priority:2};expect(parseStructuredDraft(JSON.stringify(f))).toMatchObject({dueDate:"2026-10-10",priority:2});});
 it("один раз исправляет неверный формат модели",async()=>{vi.mocked(callUnifiedAi).mockResolvedValueOnce('{"title":"Неполный ответ"}').mockResolvedValueOnce(JSON.stringify(fixture()));expect((await structureTaskDraft("Ну надо исправить сдачу, без лишнего блока" )).description).toContain("## Работа");expect(callUnifiedAi).toHaveBeenCalledTimes(2);});
 it("не возвращает внутренний контракт и сохраняет исходный текст при двух сбоях",async()=>{vi.mocked(callUnifiedAi).mockResolvedValue('{}');await expect(structureTaskDraft("Поручение")).rejects.toThrow("Исходный текст сохранён");expect(callUnifiedAi).toHaveBeenCalledTimes(2);});
 it("не повторяет сбой провайдера как ошибку JSON",async()=>{vi.mocked(callUnifiedAi).mockRejectedValue(Error('provider unavailable'));let failure:unknown;try{await structureTaskDraft("Поручение");}catch(error){failure=error;}expect((failure as Error)?.message).toBe('provider unavailable');expect(callUnifiedAi).toHaveBeenCalledTimes(1);});
 it("HTTP возвращает поля нативной формы без требования preparation",async()=>{const app=Fastify();registerAiRoutes(app);vi.mocked(callUnifiedAi).mockResolvedValue(JSON.stringify(fixture()));try{const response=await app.inject({method:"POST",url:"/api/ai/structure-task",payload:{text:"Исправь сдачу шага"}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({title:fixture().title,subtasks:fixture().subtasks,dueDate:null,priority:null});expect(response.json().preparation).toBeUndefined();}finally{await app.close();}});
});
