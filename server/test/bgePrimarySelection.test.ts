import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { resetJevSettings, saveJevSettings } from "../src/lib/jev.js";
const getEmbeddings = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/embeddingClient.js", () => ({ getEmbeddings }));
import { selectSkillsByJev, filterMemoryByJev } from "../src/lib/memorySkillsJev.js";
beforeAll(() => { migrate(); runMigrations(); });
beforeEach(() => { resetJevSettings(); getEmbeddings.mockReset(); vi.stubGlobal("fetch", vi.fn()); });
it("BGE выбирает навык до JEV при уверенном совпадении", async () => {
 saveJevSettings({ apiKey: "fixture", skillsEnabled: true });
 const skills=[{name:"youtube-research",description:"Разбор видео YouTube"},...Array.from({length:6},(_,i)=>({name:"other-"+i,description:"несвязанный навык"}))];
 getEmbeddings.mockResolvedValue({embeddings:[[1,0],[.9,.1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1]],dim:2,durationMs:1});
 const out=await selectSkillsByJev({title:"Разбери YouTube видео",description:null},skills);
 expect(out?.has("youtube-research")).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it("BGE ранжирует память до JEV при уверенном совпадении", async () => {
 saveJevSettings({ apiKey: "fixture", memoryRecallEnabled: true });
 getEmbeddings.mockResolvedValue({embeddings:[[1,0],[.1,.9],[.95,.05]],dim:2,durationMs:1});
 const items=[{text:"не по теме",title:"a",pinned:false},{text:"YouTube субтитры",title:"b",pinned:false}];
 const out=await filterMemoryByJev("как получить текст из YouTube",items);
 expect(out?.[0]?.title).toBe("b"); expect(fetch).not.toHaveBeenCalled();
});
