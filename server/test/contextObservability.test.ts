import * as noteSearch from "../src/lib/noteSearch.js";
import * as memoryLib from "../src/lib/memory.js";
import { roleProjectContext } from "../src/runtime/roleProjectContext.js";
import { buildApp } from "../src/index.js";
import { afterAll, beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import db, {migrate} from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { withObservationContext, startObservation, finishObservation, readObservability, keyIdentity, readJevUsage } from "../src/lib/contextObservability.js";
import { evaluateJev, saveJevSettings, resetJevSettings } from "../src/lib/jev.js";
import { checkContextObservability } from "../src/lib/contextObservabilityWatcher.js";
import { buildInProcessTaskContext } from "../src/runtime/taskContextBridge.js";
let app:Awaited<ReturnType<typeof buildApp>>;
beforeAll(async()=>{migrate();runMigrations();app=await buildApp();});
afterAll(async()=>{await app.close();});
beforeEach(()=>{db.prepare("DELETE FROM context_operations").run(); resetJevSettings();});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
const record=(key:string,usage?:any)=>{const id=startObservation("jev","skills",{keyId:key});finishObservation(id,{status:"ok",inputCount:12,outputCount:4,usage});return id;};
describe("контекст и JEV: наблюдаемость",()=>{
 it("ошибка чтения памяти не исчезает из наблюдаемости",async()=>{
 const prepare=db.prepare.bind(db);
 vi.spyOn(db,"prepare").mockImplementation(((sql:string)=>{if(sql.includes("FROM memories m WHERE"))throw Error("private failure");return prepare(sql);}) as typeof db.prepare);
 await expect(memoryLib.recall({roleKey:"builder",query:"q"})).rejects.toThrow();
 expect(readObservability("24h").events.find(e=>e.scenario==="teamMemory")).toMatchObject({status:"error",reason:"source_unavailable",role:"builder"});
 });

 it("отказ библиотеки проекта виден отдельно от отсутствия знаний",async()=>{
 vi.spyOn(memoryLib,"memoryBlock").mockResolvedValue("");
 vi.spyOn(noteSearch,"searchNotes").mockImplementation(()=>{throw Error("private");});
 await roleProjectContext({role:"builder",taskId:"fixture-missing-task",query:"q"});
 expect(readObservability("24h").events.find(e=>e.scenario==="projectLibrary")).toMatchObject({status:"error",reason:"source_unavailable",role:"builder",taskId:"fixture-missing-task"});
 });

 it("доступен только владельцу и проверяет период",async()=>{
 const headers=(id:string)=>({authorization:'Bearer '+app.jwt.sign({id})});
 expect((await app.inject({method:'GET',url:'/api/jev/usage'})).statusCode).toBe(401);
 expect((await app.inject({method:'GET',url:'/api/coordination/context-observability',headers:headers('role_builder')})).statusCode).toBe(403);
 const owner=(db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as any).id;
 expect((await app.inject({method:'GET',url:'/api/jev/usage?window=all',headers:headers(owner)})).statusCode).toBe(400);
 const r=await app.inject({method:'GET',url:'/api/jev/usage?window=month',headers:headers(owner)});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({hasKey:false,calls:0,scope:'taskflow_current_key'});
 });
 it("timeout, испорченный JSON и низкая уверенность остаются наблюдаемыми",async()=>{
 saveJevSettings({apiKey:'test-key',planProfileEnabled:true});
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new DOMException('private','TimeoutError')).mockResolvedValueOnce(new Response('not-json')));
 const questions={a:{type:'noul' as const,instructions:'q'}};
 await evaluateJev('s',questions,{scenario:'skills'});await evaluateJev('s',questions,{scenario:'skills'});
 expect(readObservability('24h').events.map(e=>e.reason).sort()).toEqual(['invalid_response','timeout']);
 });
 it("смена настроенного ключа сохраняет раздельную историю",()=>{
 saveJevSettings({apiKey:'old-secret'});const key=keyIdentity('https://api.typesafe.ai','old-secret');record(key,{input_tokens:10,output_tokens:0});
 saveJevSettings({apiKey:'new-secret'});const next=keyIdentity('https://api.typesafe.ai','new-secret');expect(readJevUsage(next,'month').calls).toBe(0);expect(readJevUsage(key,'month').calls).toBe(1);
 });

 it("изолирует две параллельные роли и сохраняет завершение по id",async()=>{
 await Promise.all(["a","b"].map(role=>withObservationContext({role,taskId:role,runId:role},async()=>{
 const id=startObservation("enricher","repository");await new Promise(r=>setTimeout(r,role==="a"?5:1));finishObservation(id,{status:"ok",outputCount:1});})));
 const r=readObservability("24h");expect(r.events).toHaveLength(2);for(const e of r.events)expect(e.role).toBe(e.taskId);
 });
 it("различает неизвестный расход и нулевой, отделяет новый ключ и провайдера",()=>{
 const a=keyIdentity("https://a.test","secret-a"),b=keyIdentity("https://a.test","secret-b");
 expect(a).not.toContain("secret");expect(a).not.toBe(b);expect(a).not.toBe(keyIdentity("https://b.test","secret-a"));
 record(a,{input_tokens:10,output_tokens:2});record(a);record(b,{input_tokens:300,output_tokens:1});
 const u=readJevUsage(a,"week");expect(u.calls).toBe(2);expect(u.inputTokens).toBe(10);expect(u.unknownUsageCalls).toBe(1);expect(u.moneyStatus).toBe("unavailable");
 expect(JSON.stringify(u)).not.toContain(a);
 });
 it("не включает старые операции в короткий период, но сохраняет историю ключа",()=>{
 const id=record("x",{input_tokens:25,output_tokens:0});db.prepare("UPDATE context_operations SET started_at=? WHERE id=?").run(new Date(Date.now()-2*86400000).toISOString(),id);
 expect(readJevUsage("x","24h").calls).toBe(0);expect(readJevUsage("x","week").calls).toBe(1);
 });
 it("отрицательный usage не подменяет реальную статистику",()=>{record("x",{input_tokens:-5,output_tokens:2});expect(readJevUsage("x","week").unknownUsageCalls).toBe(1);});
 it("учитывает ответ JEV и ошибку без тела ошибки и ключа",async()=>{
 saveJevSettings({apiKey:"test-secret-key",skillsEnabled:true});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({model:"x",answers:{a:{type:"noul",noul:0.8}},usage:{input_tokens:33,output_tokens:2}}))).mockRejectedValueOnce(new Error("test-secret-key private payload")));
 await evaluateJev("private state",{a:{type:"noul",instructions:"private question"}},{scenario:"skills"});
 await evaluateJev("private state",{a:{type:"noul",instructions:"q"}},{scenario:"skills"});
 const r=readObservability("24h");expect(r.events.map(e=>e.status).sort()).toEqual(["error","ok"]);
 expect(r.events.find(e=>e.status==="ok")?.inputTokens).toBe(33);expect(JSON.stringify(r)).not.toMatch(/test-secret-key|private payload|private state|private question/);
 });
 it("отмечает пропуск без ключа и неверный ответ, а не успешную оценку",async()=>{
 await evaluateJev("s",{a:{type:"noul",instructions:"q"}},{scenario:"skills"});
 saveJevSettings({apiKey:"test-key"});vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('{}')));
 await evaluateJev("s",{a:{type:"noul",instructions:"q"}},{scenario:"skills"});
 expect(readObservability("24h").events.map(e=>e.reason).sort()).toEqual(["invalid_response","no_key"]);
 });
 it("сохраняет ошибку TaskContext после повторов и фактические компоненты успешного пакета",async()=>{
 await expect(buildInProcessTaskContext({task:{id:"a"},actor:{id:"role_developer",name:"D"}},async()=>{throw Error("private");})).rejects.toThrow();
 expect(readObservability("24h").events[0].status).toBe("error");
 await buildInProcessTaskContext({task:{id:"a"},actor:{id:"role_developer",name:"D"}},async()=>JSON.stringify({prompt:"x",summary:"s",observations:[{scenario:"kb",status:"ok",inputCount:5,outputCount:2,durationMs:10,details:["doc-a"]}]}));
 expect(readObservability("24h").events.find(e=>e.scenario==="kb")).toMatchObject({inputCount:5,outputCount:2});
 });
 it("проба действительно пишет и читает, но не оставляет событий",()=>{expect(checkContextObservability().ok).toBe(true);expect(readObservability("24h").events).toHaveLength(0);});
});
