import {describe,it,expect,vi,beforeEach} from "vitest";
import {roleProjectContext,roleProjectSnapshot} from "../src/runtime/roleProjectContext.js";
import {memoryBlock} from "../src/lib/memory.js";
import {searchNotes} from "../src/lib/noteSearch.js";
vi.mock("../src/lib/memory.js",()=>({memoryBlock:vi.fn(async()=>"Память команды: уже решали"),memoryTopicHint:vi.fn(()=>""),recall:vi.fn(async()=>[])}));
vi.mock("../src/lib/noteSearch.js",()=>({searchNotes:vi.fn(()=>[{id:"doc-1",title:"Apple EventKit",folder:"Knowledge Base",updated_at:"today",text:"Уже реализовано в приложении"}])}));
beforeEach(()=>vi.clearAllMocks());
describe("знания в начале чат-сессии",()=>{
 it("память доставляет, библиотеку в промпт не кладёт",async()=>{
  const text=await roleProjectContext({role:"builder",query:"Apple календарь"});
  expect(memoryBlock).toHaveBeenCalledWith(expect.objectContaining({roleKey:"builder",query:"Apple календарь"}));
  expect(searchNotes).not.toHaveBeenCalled();
  expect(text).not.toContain("doc-1");
  expect(text).not.toContain("Библиотека TaskFlow");
  expect(text).not.toContain("Актуальные данные проекта");
  expect(text).toContain("taskflow_remember");
  expect(text).toContain(".claude");
 });
 it("без проекта и задачи не шлёт пустой JSON",()=>{
  const text=roleProjectSnapshot("builder",null);
  expect(text).not.toContain("Актуальные данные проекта");
  expect(text).not.toContain('"project":null');
 });
});
