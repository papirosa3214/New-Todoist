import {beforeAll,afterAll,it,expect} from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {buildRoleToolCatalog,installNativeToolCore} from "../src/runtime/roleToolCatalog.js";
import {createAgentSession,ModelRuntime,SessionManager,SettingsManager} from "@earendil-works/pi-coding-agent";

beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});

/**
 * Что реально уходит в запрос к модели: ядро операций, а не весь каталог.
 * Модель скриптованная (локальный mock): первый ход зовёт загрузчик, второй —
 * подключённую операцию.
 */
it("в запрос уходит ядро, подключённая операция — в следующий",async()=>{
  const requests:{names:string[];bytes:number}[]=[];
  const server=http.createServer((req,res)=>{
    let raw="";
    req.on("data",chunk=>{raw+=chunk;});
    req.on("end",()=>{
      let body:any={};
      try{body=JSON.parse(raw||"{}");}catch{}
      const names=(body.tools||[]).map((tool:any)=>tool.name??tool.function?.name).filter(Boolean);
      requests.push({names,bytes:raw.length});
      const step=requests.length;
      const deltas:any[]=step===1
        ?[{tool_calls:[{index:0,id:"call_1",type:"function",function:{name:"taskflow_tools",arguments:JSON.stringify({names:["taskflow_doc_write"]})}}]}]
        :step===2
          ?[{tool_calls:[{index:0,id:"call_2",type:"function",function:{name:"taskflow_doc_write",arguments:JSON.stringify({content:"проверка"})}}]}]
          :[{content:"готово"}];
      res.writeHead(200,{"content-type":"text/event-stream"});
      for(const delta of deltas){
        res.write(`data: ${JSON.stringify({id:"x",object:"chat.completion.chunk",created:0,model:"scripted",choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      }
      res.write(`data: ${JSON.stringify({id:"x",object:"chat.completion.chunk",created:0,model:"scripted",choices:[{index:0,delta:{},finish_reason:step===3?"stop":"tool_calls"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",()=>resolve()));
  const port=(server.address() as any).port;

  const agentDir=fs.mkdtempSync(path.join(os.tmpdir(),"pi-native-payload-"));
  const modelsPath=path.join(agentDir,"models.json");
  fs.writeFileSync(modelsPath,JSON.stringify({providers:{mock:{baseUrl:`http://127.0.0.1:${port}/v1`,api:"openai-completions",apiKey:"dummy",models:[{id:"scripted"}]}}}));

  const runtime=await ModelRuntime.create({modelsPath} as any);
  const model=runtime.getModel("mock","scripted");
  expect(model).toBeTruthy();

  const catalog=buildRoleToolCatalog({role:"builder",model:"scripted",mode:"work",runId:"payload"});
  const {session}=await createAgentSession({
    cwd:process.cwd(),model,modelRuntime:runtime,thinkingLevel:"off",
    tools:[...catalog.registeredNames],customTools:catalog.customTools,
    sessionManager:SessionManager.inMemory(),settingsManager:SettingsManager.inMemory({compaction:{enabled:false}}),
  } as any);
  installNativeToolCore(session,catalog,[]);

  const called:string[]=[];
  session.subscribe((event:any)=>{
    if(event.type==="message_end"){
      for(const part of event.message?.content??[])if(part.type==="toolCall")called.push(part.name);
    }
  });

  await session.prompt("Нужна операция записи документа.");

  // Первый запрос: ядро, без общего шлюза.
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[0].names).toContain("taskflow_tools");
  expect(requests[0].names).toContain("taskflow_task");
  expect(requests[0].names).not.toContain("taskflow");
  expect(requests[0].names).not.toContain("taskflow_doc_write");
  expect(requests[0].names.length).toBeLessThan(catalog.registeredNames.length);
  // Второй запрос: подключённая операция уже в списке.
  expect(requests[1].names).toContain("taskflow_doc_write");
  // Модель позвала загрузчик, затем нативную операцию по имени.
  expect(called).toContain("taskflow_tools");
  expect(called).toContain("taskflow_doc_write");

  session.dispose();
  server.close();
  fs.rmSync(agentDir,{recursive:true,force:true});
},30000);
