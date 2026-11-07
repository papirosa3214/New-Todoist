import {beforeAll,beforeEach,afterEach,it,expect,vi} from "vitest";
import {migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {saveJevSettings,resetJevSettings,getJevSettings} from "../src/lib/jev.js";
import {reviewThoughts,thoughtNudge,looksLikeLoop,REVIEW_EVERY,NUDGE_COOLDOWN} from "../src/lib/thoughtReviewJev.js";
beforeAll(()=>{migrate();runMigrations();});
beforeEach(()=>{resetJevSettings();saveJevSettings({apiKey:"fixture-jev-key"});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
const state=(choice:string,confidence=0.9)=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({model:"jev-1",answers:{state:{type:"choice",choice,confidence,probabilities:{[choice]:1}}}}))));
const input={taskId:"t",task:"Починить сортировку",step:"Найти причину",thoughts:["Он хочет по дате или по приоритету?","Зачем он сказал «сверху»?"]};
it("направление включено по умолчанию и имеет порог",()=>{
 expect(getJevSettings()).toMatchObject({thoughtReviewEnabled:true,thoughtReviewMinConfidence:0.7});
});
it("непонимание задачи ведёт к вопросу владельцу, а не к выбору трактовки молча",async()=>{
 state("unclear");const s=await reviewThoughts(input);expect(s).toBe("unclear");
 const nudge=thoughtNudge(s!,{task:input.task,step:input.step})!;
 expect(nudge).toContain("«Починить сортировку»");expect(nudge).toContain("taskflow_ask_user_question");expect(nudge).toContain("taskflow_recall");
 const sent=JSON.parse(String((fetch as any).mock.calls[0][1].body));expect(sent.state.thoughts).toHaveLength(2);
});
it("круг ведёт в память и базу знаний и к смене подхода",()=>{
 const nudge=thoughtNudge("looping",{task:"X",step:""})!;
 expect(nudge).toContain("taskflow_kb_search");expect(nudge).toContain("другую гипотезу");
});
it("всё в порядке — без подсказки; неуверенность — молчим",async()=>{
 expect(thoughtNudge("ok",{task:"X",step:""})).toBeNull();
 state("looping",0.4);expect(await reviewThoughts(input)).toBeNull();
});
it("выключено — оценщик не вызывается",async()=>{
 saveJevSettings({thoughtReviewEnabled:false});const network=vi.fn();vi.stubGlobal("fetch",network);
 expect(await reviewThoughts(input)).toBeNull();expect(network).not.toHaveBeenCalled();
});
it("разбор не чаще раза в 10 ответов (владелец 01.11.2026: он был 54% вызовов JEV)",()=>{
 expect(REVIEW_EVERY).toBe(10);
 expect(NUDGE_COOLDOWN).toBeGreaterThanOrEqual(REVIEW_EVERY);
});
it("круг ловится локально, без вызова оценщика",()=>{
 const repeated="Сортировка падает, потому что сравнение дат неверно, проверяю функцию сравнения и снова смотрю сортировку";
 const other="Проверю сборку проекта и запущу тесты, потом посмотрю логи сервера и напишу владельцу отчёт";
 expect(looksLikeLoop(repeated,[repeated])).toBe(true);
 expect(looksLikeLoop(repeated,[other])).toBe(false);
 expect(looksLikeLoop("ок",[repeated])).toBe(false);
});
