import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";

const features=["http-proxy","sse","oauth-refresh","websocket","loopback-policy"];
const report:any={scope:"preparation only; no reconnection",checked_at:new Date().toISOString(),installed_protocol:null,installed_features:[],active_bindings:{},metadata:[],blockers:[]};
const url=process.env.TASKFLOW_SECRET_BROKER_URL??"http://127.0.0.1:28443";
try{
 const r=await fetch(new URL("/healthz",url),{signal:AbortSignal.timeout(5000)});
 report.installed_protocol=r.headers.get("x-broker-protocol");
 report.installed_features=(r.headers.get("x-broker-features")??"").split(",").filter(Boolean);
 if(!r.ok||report.installed_protocol!=="2"||features.some(f=>!report.installed_features.includes(f)))report.blockers.push("prepared broker protocol is not installed");
}catch{report.blockers.push("broker health unavailable")}
for(const unit of ["taskflow-server.service","taskflow-secretary-voice.service"]){
 try{
  const pid=Number(execFileSync("systemctl",["--user","show",unit,"-p","MainPID","--value"],{encoding:"utf8"}).trim());
  if(!pid){report.active_bindings[unit]="service not running";continue}
  const entries=fs.readFileSync("/proc/"+pid+"/environ","utf8").split("\0");
  const value=entries.find(s=>s.startsWith("TASKFLOW_SECRET_BROKER_BINDINGS="))?.slice("TASKFLOW_SECRET_BROKER_BINDINGS=".length);
  report.active_bindings[unit]=value?.trim()&&value.trim()!=="[]"?"configured":"disabled";
  if(report.active_bindings[unit]==="configured")report.blockers.push("hold violated: active broker bindings are configured");
 }catch{report.active_bindings[unit]="unknown";report.blockers.push("cannot confirm active binding state")}
}
try{
 const file=process.env.TASKFLOW_SECRET_BROKER_TOKEN_PATH??path.join(os.homedir(),".config/taskflow/secret-broker-owner.token");
 const token=fs.readFileSync(file,"utf8").trim();
 const r=await fetch(new URL("/owner-api/secrets",url),{headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw new Error();
 const result:any=await r.json();
 report.metadata=(Array.isArray(result)?result:result.secrets??[]).map((s:any)=>({id:s.id,name:s.name,origin:s.origin,header_name:s.header_name}));
 const composio=report.metadata.find((s:any)=>s.id==="composio-taskflow");
 report.cutover_metadata_review={composio:composio?{current_origin:composio.origin,current_header:composio.header_name,requires_sdk_destination_and_header_check:true}:"not registered"};
}catch{report.blockers.push("owner metadata API unavailable")}
report.ready_to_reconnect=false; // Deliberately requires an owner-approved final cutover and credential/provider smoke checks.
report.remaining_gate="install prepared broker, verify policies and staged credentials, then owner-authorized cutover";
process.stdout.write(JSON.stringify(report,null,2)+"\n");
