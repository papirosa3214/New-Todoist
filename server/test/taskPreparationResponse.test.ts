import {describe,it,expect,vi,beforeEach} from "vitest";
const mock=vi.hoisted(()=>({call:vi.fn()}));
vi.mock("../src/lib/aiClient.js", async original=>({...await original<any>(),callUnifiedAi:mock.call}));
vi.mock("../src/db.js",()=>({default:{prepare:()=>({all:()=>[]})}}));
import {parsePreparationResponse, prepareTaskCard, NonTaskInputError} from "../src/lib/taskPreparation.js";
const prep=(role:any=null)=>({intent:"executable_task",representation:"checklist",reason:"Одна работа",question:null,workstreams:[{key:"work_1",title:"Результат",result:"Проверяемый результат",role,depends_on:[],parallel_with:[]}]});
const reply=()=>JSON.stringify({title:"Работа",description:"Описание",question:null,children:[],subtasks:[],preparation:prep()});
beforeEach(()=>mock.call.mockReset());
describe("Ответ модели подготовки",()=>{
 it("показывает отсутствующий контракт и имена полей без значений",()=>{
  expect(()=>parsePreparationResponse('{"title":"private text"}',["builder"])).toThrow(/preparation.*title/);
  expect(()=>parsePreparationResponse('{"title":"private text"}',["builder"])).not.toThrow(/private text/);
 });
 it("называет конкретное поле и неизвестную роль",()=>{
  expect(()=>parsePreparationResponse(JSON.stringify({preparation:prep("backend_developer")}),["builder"])).toThrow(/workstreams\[0\].role.*backend_developer.*builder/);
 });
 it("отличает пропущенную роль от неизвестной и принимает null",()=>{
  const missing=prep();delete (missing.workstreams[0] as any).role;
  expect(()=>parsePreparationResponse(JSON.stringify({preparation:missing}),["builder"])).toThrow(/role: поле отсутствует/);
  expect(parsePreparationResponse(JSON.stringify({preparation:prep()}),["builder"]).preparation.workstreams[0].role).toBeNull();
 });
 it("один раз исправляет контракт и всегда передаёт каталог ролей",async()=>{
  mock.call.mockResolvedValueOnce('{"title":"Работа"}').mockResolvedValueOnce(reply());
  const card=await prepareTaskCard("Подготовить журнал",[],{sourceRecordId:"auto:344"});
  expect(card.title).toBe("Работа");expect(mock.call).toHaveBeenCalledTimes(2);
  expect(mock.call.mock.calls[0][0].systemPrompt).toContain("Допустимые ключи включённых ролей:");
  expect(mock.call.mock.calls[0][0].systemPrompt).toContain("подготовка существующей карточки");
  expect(mock.call.mock.calls[1][0].systemPrompt).toContain("отсутствует объект preparation");
 });
 it("не повторяет сетевой сбой и содержательный вопрос",async()=>{
  mock.call.mockRejectedValueOnce(new Error("HTTP 503"));await expect(prepareTaskCard("Работа",[])).rejects.toThrow("HTTP 503");expect(mock.call).toHaveBeenCalledTimes(1);
  mock.call.mockReset();mock.call.mockResolvedValueOnce(JSON.stringify({preparation:{intent:"informational_question",question:"Какой источник?"}}));
  await expect(prepareTaskCard("Что происходит?",[])).rejects.toThrow(NonTaskInputError);expect(mock.call).toHaveBeenCalledTimes(1);
 });
 it("ограничивает исправление двумя вызовами и сохраняет обе причины",async()=>{
  mock.call.mockResolvedValueOnce('{"title":"Работа"}').mockResolvedValueOnce(JSON.stringify({preparation:prep("ghost")}));
  await expect(prepareTaskCard("Работа",[])).rejects.toThrow(/Первый ответ:.*preparation.*Повторный ответ:.*ghost/);
  expect(mock.call).toHaveBeenCalledTimes(2);
 });
});
