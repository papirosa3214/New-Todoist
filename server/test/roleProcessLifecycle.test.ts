import { it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RoleProcessLease, PROCESS_GUARD, PROCESS_LEASE_ROOT } from "../src/runtime/roleProcessLease.js";
import { isolatedBashOperations, grantRoleAccess, ROLE_USER } from "../src/runtime/localRoleOperations.js";
const work = fs.mkdtempSync(path.join(os.homedir(), ".local/state/taskflow-runs/worktrees/process-test-"));
grantRoleAccess(work);
afterAll(()=>fs.rmSync(work,{recursive:true,force:true}));
const asRole = (s:string) => execFileSync("sudo", ["-n", "-u", ROLE_USER, "/bin/bash", "-c", s], {encoding:"utf8",stdio:["ignore","pipe","pipe"]});
it("abort kills a nohup descendant across the sudo user boundary", async () => {
  const controller = new AbortController(); let output="";let pid="";
  try {
    const run = isolatedBashOperations(work).exec(`nohup setsid sh -c 'echo PID=$$ > ${work}/abort.pid; exec sleep 120' >/dev/null 2>&1 & sleep 0.2; cat ${work}/abort.pid; wait`, work, {
      signal:controller.signal, onData:b=>{output+=b.toString();const match=output.match(/^PID=(\d+)$/m);if(match){pid=match[1];controller.abort();}}
    });
    await expect(run).rejects.toThrow();
    expect(pid).toMatch(/^\d+$/);
    const alive = asRole(`if kill -0 ${pid} 2>/dev/null; then echo alive; else echo gone; fi`).trim();
    expect(alive).toBe("gone");
  } finally { if(pid) try{asRole(`kill -KILL ${pid} 2>/dev/null || true`);}catch{} }
},15000);

it("standalone bash does not leak a detached nohup child after returning", async()=>{
 let pid="";try{
  let out="";await isolatedBashOperations(work).exec(`nohup setsid sh -c 'echo PID=$$ > ${work}/normal.pid; exec sleep 120' >/dev/null 2>&1 & sleep 0.2; cat ${work}/normal.pid`,work,{onData:b=>out+=b.toString()});
  pid=out.trim().match(/^PID=(\d+)$/m)?.[1]??"";expect(pid).toMatch(/^\d+$/);
  expect(asRole(`if kill -0 ${pid} 2>/dev/null; then echo alive; else echo gone; fi`).trim()).toBe("gone");
 }finally{if(pid)asRole(`kill -KILL ${pid} 2>/dev/null || true`);}
},15000);

it("background server survives between tools, then closes with its role lease",async()=>{
 const lease=new RoleProcessLease(ROLE_USER);let pid="";
 try{
  let out="";const ops=isolatedBashOperations(work,lease);
  await ops.exec(`nohup setsid sh -c 'echo PID=$$ > ${work}/shared.pid; exec sleep 120' >/dev/null 2>&1 & sleep 0.2; cat ${work}/shared.pid`,work,{onData:b=>out+=b.toString()});
  pid=out.match(/^PID=(\d+)$/m)?.[1]??"";expect(pid).toMatch(/^\d+$/);
  expect(asRole(`kill -0 ${pid} && echo alive`).trim()).toBe("alive");
  await ops.exec("true",work,{onData:()=>{}});
  expect(asRole(`kill -0 ${pid} && echo alive`).trim()).toBe("alive");
  await lease.dispose();
  expect(asRole(`if kill -0 ${pid} 2>/dev/null; then echo alive; else echo gone; fi`).trim()).toBe("gone");
 }finally{await lease.dispose();if(pid)asRole(`kill -KILL ${pid} 2>/dev/null || true`);}
},15000);
it("watchdog reaps children after their owning Node process exits",()=>{
 const modulePath=path.resolve(import.meta.dirname,"../src/runtime/localRoleOperations.ts");
 const leasePath=path.resolve(import.meta.dirname,"../src/runtime/roleProcessLease.ts");
 const code=`import {isolatedBashOperations,ROLE_USER} from ${JSON.stringify(modulePath)};import {RoleProcessLease} from ${JSON.stringify(leasePath)};const lease=new RoleProcessLease(ROLE_USER);let out='';await isolatedBashOperations(${JSON.stringify(work)},lease).exec(${JSON.stringify(`nohup setsid sh -c 'echo PID=$$ > ${work}/owner.pid; exec sleep 120' >/dev/null 2>&1 & sleep 0.2; cat ${work}/owner.pid`)},${JSON.stringify(work)},{onData:b=>out+=b.toString()});console.log(JSON.stringify({lease:lease.id,out}));process.exit(0);`;
 const result=JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:path.resolve(import.meta.dirname,".."),encoding:"utf8"}).trim());
 const pid=result.out.match(/^PID=(\d+)$/m)?.[1];expect(pid).toBeTruthy();
 try{
  const reaped=JSON.parse(asRole(`/usr/bin/python3 '${PROCESS_GUARD}' --probe '${result.lease}'`));
  expect(reaped.matched).toBeGreaterThan(0);
  expect(asRole(`if kill -0 ${pid} 2>/dev/null; then echo alive; else echo gone; fi`).trim()).toBe("gone");
 }finally{asRole(`kill -KILL ${pid} 2>/dev/null || true`);fs.rmSync(path.join(PROCESS_LEASE_ROOT,result.lease+".json"),{force:true});}
},15000);

it("real Chromium children inherit ownership and close with the run",async()=>{
 const lease=new RoleProcessLease(ROLE_USER);const marker=path.join(work,"browser-ready");
 const code=`import {chromium} from ${JSON.stringify(path.resolve(import.meta.dirname,"../../node_modules/playwright/index.mjs"))};import fs from 'node:fs';await chromium.launch();fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`;
 const quoted="'"+code.replaceAll("'", "'\"'\"'")+"'";
 try{
  await isolatedBashOperations(work,lease).exec(`PLAYWRIGHT_BROWSERS_PATH=/home/maksim/.cache/ms-playwright nohup setsid node --input-type=module -e ${quoted} > ${work}/browser.log 2>&1 &`,work,{onData:()=>{}});
  for(let i=0;i<50&&!fs.existsSync(marker);i++)await new Promise(r=>setTimeout(r,100));
  expect(fs.existsSync(marker),fs.existsSync(path.join(work,"browser.log"))?fs.readFileSync(path.join(work,"browser.log"),"utf8"):"no browser log").toBe(true);
  const before=JSON.parse(asRole(`/usr/bin/python3 '${PROCESS_GUARD}' --inspect --lease '${lease.id}'`));
  expect(before.by_kind.browser).toBeGreaterThan(0);
  await lease.dispose();
  const after=JSON.parse(asRole(`/usr/bin/python3 '${PROCESS_GUARD}' --inspect --lease '${lease.id}'`));
  expect(after.matched).toBe(0);
 }finally{await lease.dispose();}
},20000);

it("cleanup also kills the shell that could respawn its children",async()=>{
 const lease=new RoleProcessLease(ROLE_USER);
 try{
  await isolatedBashOperations(work,lease).exec("nohup setsid bash -c 'while true; do sleep 10; done' >/dev/null 2>&1 &",work,{onData:()=>{}});
  const before=JSON.parse(asRole(`/usr/bin/python3 '${PROCESS_GUARD}' --inspect --lease '${lease.id}'`));expect(before.matched).toBeGreaterThan(0);
  await lease.dispose();await new Promise(r=>setTimeout(r,200));
  const after=JSON.parse(asRole(`/usr/bin/python3 '${PROCESS_GUARD}' --inspect --lease '${lease.id}'`));expect(after.matched).toBe(0);
 }finally{await lease.dispose();}
},15000);

it("timeout cleans detached descendants even when the role remains active",async()=>{
 const lease=new RoleProcessLease(ROLE_USER);let pid="";let out="";
 try{
  await expect(isolatedBashOperations(work,lease).exec(`nohup setsid sh -c 'echo PID=$$ > ${work}/timeout.pid; exec sleep 120' >/dev/null 2>&1 & sleep 0.2; cat ${work}/timeout.pid; wait`,work,{timeout:.5,onData:b=>out+=b.toString()})).rejects.toThrow(/timeout/);
  pid=out.match(/^PID=(\d+)$/m)?.[1]??"";expect(pid).toMatch(/^\d+$/);
  expect(asRole(`if kill -0 ${pid} 2>/dev/null; then echo alive; else echo gone; fi`).trim()).toBe("gone");
 }finally{await lease.dispose();if(pid)asRole(`kill -KILL ${pid} 2>/dev/null || true`);}
},15000);
