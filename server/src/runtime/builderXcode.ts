import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { roleHome } from "./roleHome.js";

export function builderXcodeAllowed(role:string,mode:string):boolean {
  return role === "builder" && mode === "work";
}
const empty = () => ({tools: [] as any[], close: async()=>{}});
export async function connectBuilderXcode(role:string,mode:string) {
  if(!builderXcodeAllowed(role,mode)) return empty();
  const file=path.join(roleHome("builder").dir,"mcp","xcode.json");
  if(!fs.existsSync(file)) return empty();
  const config=JSON.parse(fs.readFileSync(file,"utf8")) as {command:string;args:string[]};
  if(config.command!=="/usr/bin/ssh" || config.args.at(-1)!=="mcp") throw new Error("Неверная конфигурация выделенного Xcode-входа");
  const client=new Client({name:"taskflow-builder-xcode",version:"1.0.0"});
  const transport=new StdioClientTransport({...config,stderr:"ignore"});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([client.connect(transport),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("MacBook Xcode MCP: время подключения истекло")),20_000);})]);
    clearTimeout(timer);
    const listed=await client.listTools();
    const tools:any[]=listed.tools.map(t=>({
      name:"mcp__xcode__"+t.name,label:"MacBook Xcode · "+t.name,
      description:(t.description??t.name)+". Выделенная копия: /Users/max/Проекты/TaskFlowDeveloper. Не меняй каноническую папку приложения.",
      parameters:Type.Unsafe<Record<string,unknown>>(t.inputSchema),
      execute:async(_id:string,args:Record<string,unknown>,signal?:AbortSignal)=>{
        const result=await client.callTool({name:t.name,arguments:args},undefined,{signal,timeout:600_000});
        if(result.isError)throw new Error(JSON.stringify(result.content));
        return {content:result.content,details:{source:"MacBook Xcode",tool:t.name}};
      }
    }));
    function remote(command:string,input="") {
      return new Promise<string>((resolve,reject)=>{
        const p=spawn(config.command,[...config.args.slice(0,-1),command],{stdio:["pipe","pipe","pipe"]});
        let out="",err="";const timeout=setTimeout(()=>p.kill(),60_000);
        p.stdout.on("data",chunk=>{out+=chunk;if(out.length>4*1024*1024)p.kill();});p.stderr.on("data",chunk=>{err+=chunk;});
        p.on("error",e=>{clearTimeout(timeout);reject(e);});p.on("close",code=>{clearTimeout(timeout);code===0?resolve(out):reject(new Error(err||"MacBook gateway failed"));});
        p.stdin.on("error",()=>{});p.stdin.end(input);
      });
    }
    const quote=(s:string)=>"'"+s.replaceAll("'", "'\"'\"'")+"'";
    for(const [name,description,parameters,command] of [
      ["mac_status","Текущая ветка и изменения выделенной копии на MacBook",Type.Object({}),()=>"status"],
      ["mac_prepare","Сгенерировать Xcode-проект из project.yml перед сборкой",Type.Object({}),()=>"prepare"],
      ["mac_push","Отправить текущую codex-ветку разработчика на GitHub",Type.Object({}),()=>"push"],
      ["mac_commit","Коммит только явно перечисленных файлов выделенной копии",Type.Object({message:Type.String(),paths:Type.Array(Type.String())}),()=>"commit"],
      ["mac_diff","Показать изменения выделенной копии",Type.Object({}),()=>"diff"],
      ["mac_read_file","Прочитать файл в выделенной копии (relative path)",Type.Object({path:Type.String()}),(a:any)=>"read "+quote(a.path)],
      ["mac_write_file","Записать файл в выделенной копии. Соблюдай AGENTS и IN_PROGRESS scope перед исходниками",Type.Object({path:Type.String(),content:Type.String()}),(a:any)=>"write "+quote(a.path)]
    ] as const) tools.push({name:"mcp__xcode__"+name,label:"MacBook · "+name,description,parameters,execute:async(_id:string,a:any)=>({content:[{type:"text",text:await remote((command as any)(a),name === "mac_commit" ? JSON.stringify(a) : (a.content??""))}],details:{source:"MacBook",tool:name}})});
    return {tools,close:()=>client.close()};
  } catch(error) {
    await client.close().catch(()=>{});await transport.close().catch(()=>{});throw error;
  } finally {clearTimeout(timer);}
}
