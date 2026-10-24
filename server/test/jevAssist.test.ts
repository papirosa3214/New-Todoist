import {beforeAll,beforeEach,afterEach,it,expect,vi} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {saveJevSettings,resetJevSettings,getJevSettings} from "../src/lib/jev.js";
import {createResultVersion} from "../src/resultVersions.js";
import {registerChatSteering,offerChatSteering} from "../src/runtime/chatSteering.js";
let assist:any={};
beforeAll(async()=>{
 migrate();runMigrations();
 try { assist=await import("../src/lib/jevAssist.js"); } catch(error:any) {if(!String(error).includes("Cannot find")&&!String(error).includes("Failed to load"))throw error;}
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES('jev-owner','Owner','jev-owner@test','fixture','owner','human')").run();
 db.prepare("INSERT INTO tasks(id,title,description,creator_id) VALUES('jev-task','Fix chat','Show verified report','jev-owner')").run();
 db.prepare("INSERT INTO chats(id,title,created_by) VALUES('jev-chat','Chat','jev-owner')").run();
});
beforeEach(()=>{resetJevSettings();saveJevSettings({apiKey:"fixture-jev-key",reportReviewEnabled:true,chatIntentEnabled:true});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
const response=(answers:any)=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({model:"jev-1.14.0",answers}))));
const intent=(choice:string,confidence=0.9)=>response({intent:{type:"choice",choice,confidence,probabilities:{[choice]:1}}});
it("exposes independent controls for the two advisory scenarios",()=>{
 expect(getJevSettings()).toMatchObject({reportReviewEnabled:true,chatIntentEnabled:true,chatIntentMinConfidence:0.7});
 saveJevSettings({reportReviewEnabled:false});expect(getJevSettings().chatIntentEnabled).toBe(true);
});
it("question guidance preserves the original request and asks for a verbal answer",async()=>{
 intent("question");const result=await assist.classifyChatIntent?.({message:"Почему ты это сделал?",history:"Роль сообщила о правке"});
 expect(result?.intent).toBe("question");const block=assist.chatIntentGuidance?.(result);
 expect(block).toContain("ответ словами");expect(block).toContain("не является разрешением");
 const sent=JSON.parse(String((fetch as any).mock.calls[0][1].body));expect(sent.state.message).toBe("Почему ты это сделал?");expect(sent.state.history).toContain("сообщила");
});
it("falls back on uncertain intent",async()=>{
 intent("execute",0.4);expect(await assist.classifyChatIntent?.({message:"Ну да"})).toBeNull();
});
it("keeps mixed requests distinct from a pure question",async()=>{
 intent("mixed");const result=await assist.classifyChatIntent?.({message:"Почему так? Исправь сортировку."});
 expect(result?.intent).toBe("mixed");expect(assist.chatIntentGuidance?.(result)).toContain("явно порученную");
});
it("does not call the provider when the scenario is disabled",async()=>{
 saveJevSettings({chatIntentEnabled:false});const network=vi.fn();vi.stubGlobal("fetch",network);
 expect(await assist.classifyChatIntent?.({message:"Что сделано?"})).toBeNull();expect(network).not.toHaveBeenCalled();
});
it("passes advisory intent into an active turn without breaking its receipt",async()=>{
 const id="intent-steer";db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,'jev-chat','jev-owner','Почему так?','chat')").run(id);
 intent("question");const steer=vi.fn(async (_text:string)=>{});const run=registerChatSteering({chatId:"jev-chat",roleId:"fixture-role",steer,outcome:Promise.resolve(true)});
 try{
 const receipt=await offerChatSteering("jev-chat","fixture-role",id,{from:"Owner",chatId:"jev-chat",chatTitle:"Chat",body:"Почему так?"});
 expect(steer.mock.calls[0]?.[0]).toContain("ответ словами");expect(receipt).not.toBeNull();
 run.observe({type:"message_start",message:{role:"user",content:steer.mock.calls[0][0]}});run.close();expect(await receipt!.consumed).toBe(true);
 }finally{run.close();}
});
it("gives the critic specific concerns and does not create a verdict",async()=>{
 const answers=Object.fromEntries(["alignment","evidence","limitations"].map(name=>[name,{type:"choice",choice:name==="evidence"?"gap":"supported",confidence:0.9,probabilities:{[name==="evidence"?"gap":"supported"]:1}}]));
 response(answers);
 const block=await assist.reviewReportByJev?.({task:{title:"Fix chat"},reports:[{id:"report-1",text:"Исправлено. Тесты пройдены."}],evidence:[]});
 expect(block).toContain("Проверки и доказательства");expect(block).toContain("не является вердиктом");
 expect(db.prepare("SELECT count(*) n FROM reviews").get()).toEqual({n:0});
});
it("loads the current task result for pre-review without leaking another task",async()=>{
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('jev-foreign','Other task','jev-owner')").run();
 createResultVersion({taskId:"jev-foreign",createdBy:"jev-owner",result:"FOREIGN_PRIVATE_RESULT",evidence:[]});
 createResultVersion({taskId:"jev-task",createdBy:"jev-owner",result:"Current submitted result",evidence:[{test:"chat",status:"passed"}]});
 response(Object.fromEntries(["alignment","evidence","limitations"].map(name=>[name,{type:"choice",choice:"supported",confidence:0.9,probabilities:{supported:1}}])));
 const block=await assist.reportReviewBlockForTask?.("jev-task");expect(block).toContain("JEV");
 const sent=JSON.parse(String((fetch as any).mock.calls[0][1].body));expect(JSON.stringify(sent.state)).toContain("Current submitted result");expect(JSON.stringify(sent.state)).not.toContain("FOREIGN_PRIVATE_RESULT");
});
it("returns no invented pre-review when no report exists",async()=>{
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('jev-empty','Empty','jev-owner')").run();
 const network=vi.fn();vi.stubGlobal("fetch",network);expect(await assist.reportReviewBlockForTask?.("jev-empty")).toBe("");expect(network).not.toHaveBeenCalled();
});

it("preserves FIFO while two intent evaluations have different latency",async()=>{
 for(const id of ["fifo-1","fifo-2"])db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,'jev-chat','jev-owner',?,'chat')").run(id,id);
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 vi.stubGlobal("fetch",vi.fn(async(_url:any,init:any)=>{
  if(JSON.parse(init.body).state.message==="fifo-1")await gate;
  return new Response(JSON.stringify({model:"jev-1.14.0",answers:{intent:{type:"choice",choice:"question",confidence:0.9,probabilities:{question:1}}}}));
 }));
 const steer=vi.fn(async(_text:string)=>{});const run=registerChatSteering({chatId:"jev-chat",roleId:"fifo-role",steer,outcome:Promise.resolve(true)});
 const source={from:"Owner",chatId:"jev-chat",chatTitle:"Chat",body:"text"};
 try{
 const first=offerChatSteering("jev-chat","fifo-role","fifo-1",source);
 const second=offerChatSteering("jev-chat","fifo-role","fifo-2",source);
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(steer).not.toHaveBeenCalled();
 release();await Promise.all([first,second]);expect(steer.mock.calls[0][0]).toContain("fifo-1");expect(steer.mock.calls[1][0]).toContain("fifo-2");
 }finally{release();run.close();}
});

it("passes report uncertainty to the critic rather than silently dropping all checks",async()=>{
 response(Object.fromEntries(["alignment","evidence","limitations"].map(name=>[name,{type:"choice",choice:"unclear",confidence:0.3,probabilities:{unclear:0.6,gap:0.4}}])));
 const block=await assist.reviewReportByJev({task:{title:"Fix"},reports:[{id:"r",text:"Done"}],evidence:[]});
 expect(block).toContain("недостаточно уверенности");expect(block).toContain("не является вердиктом");
});
