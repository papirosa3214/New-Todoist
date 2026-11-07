import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const quote = (s:string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
export const PROCESS_LEASE_ROOT = "/tmp/taskflow-role-leases-1000";
export const PROCESS_GUARD = path.resolve(import.meta.dirname, "../../scripts/role_process_guard.py");
export async function cleanupRoleProcesses(user:string, kind:"lease"|"command", token:string):Promise<void> {
  await execute("sudo", ["-n", "-u", user, "/bin/bash", "-c",
    `exec /usr/bin/python3 ${quote(PROCESS_GUARD)} --${kind} ${quote(token)}`], {timeout:10_000});
}
export class RoleProcessLease {
  readonly id = crypto.randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  constructor(readonly user:string, readonly context: Record<string,string|undefined> = {}) {}
  private get file() {return path.join(PROCESS_LEASE_ROOT, this.id+".json");}
  ensure():void {
    if(this.closed)throw new Error("role process lease already closed");
    if(this.started)return;
    fs.mkdirSync(PROCESS_LEASE_ROOT, {recursive:true,mode:0o755});
    const ownerStart = fs.readFileSync(`/proc/${process.pid}/stat`,"utf8").split(") ")[1].split(" ")[19];
    const beat=()=>{
      const temp=this.file+".tmp";
      fs.writeFileSync(temp,JSON.stringify({owner_pid:process.pid,owner_start:ownerStart,heartbeat:Date.now()/1000,context:this.context}),{mode:0o644});
      fs.renameSync(temp,this.file);
    };
    beat();this.started=true;this.timer=setInterval(()=>{try{beat();}catch(error){console.warn("[roleProcesses] lease heartbeat failed",String(error));}},30_000);this.timer.unref();
  }
  async dispose():Promise<void> {
    this.closed=true;if(this.timer)clearInterval(this.timer);
    if(!this.started)return;
    fs.rmSync(this.file,{force:true});
    await cleanupRoleProcesses(this.user,"lease",this.id);
  }
}
