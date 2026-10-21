import {describe,it,expect,vi,beforeEach} from "vitest";
import {roleProjectContext} from "../src/runtime/roleProjectContext.js";
import {memoryBlock} from "../src/lib/memory.js";
import {searchNotes} from "../src/lib/noteSearch.js";
vi.mock("../src/lib/memory.js",()=>({memoryBlock:vi.fn(async()=>"Память команды: уже решали")}));
vi.mock("../src/lib/noteSearch.js",()=>({searchNotes:vi.fn(()=>[{id:"doc-1",title:"Apple EventKit",folder:"Knowledge Base",updated_at:"today",text:"Уже реализовано в приложении"}])}));
beforeEach(()=>vi.clearAllMocks());
describe("знания в начале чат-сессии",()=>{
 it("доставляет сохранённые знания и документы до чтения кода",async()=>{
  const text=await roleProjectContext({role:"builder",query:"Apple календарь"});
  expect(memoryBlock).toHaveBeenCalledWith(expect.objectContaining({roleKey:"builder",query:"Apple календарь"}));
  expect(searchNotes).toHaveBeenCalledWith("Apple календарь",3,700);
  expect(text).toContain("doc-1");
  expect(text).toContain("Уже реализовано в приложении");
  expect(text).toContain("taskflow_remember");
  expect(text).toContain(".claude");
 });
 it("не делает сбой библиотеки невидимым и сохраняет память",async()=>{
  vi.mocked(searchNotes).mockImplementationOnce(()=>{throw new Error("index unavailable");});
  const text=await roleProjectContext({role:"builder",query:"Apple"});
  expect(text).toContain("Память команды: уже решали");
  expect(text).toContain("не удалось");
 });
});
