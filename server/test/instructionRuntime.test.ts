import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db,{migrate} from '../src/db.js';
import {runMigrations} from '../src/migrations.js';
import {chatInstructionArgs} from '../src/runtime/instructionResources.js';
import {applyOverride,composeLayer} from '../src/lib/roleContextResolver.js';

migrate();runMigrations();

describe('Pi instruction snapshot',()=>{
 it('registers all seven original builtin tools with effective descriptions',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taskflow-instruction-'));
  try {
   const key='tool.builtin.grep';
   const before=composeLayer('builder',key);
   // Discovery registers the live Pi SDK definitions before the edit.
   await chatInstructionArgs('builder',path.join(dir,'probe.json'));
   const version=composeLayer('builder',key)!.version;
   const owner=(db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as {id:string}|undefined)?.id;
   expect(owner).toBeTruthy();
   applyOverride({scope:'role',roleKey:'builder',layer:key,text:'Искать точное совпадение',action:'set',expectedVersion:version,sourceKind:'file',sourceRef:'test',createdBy:owner!});
   const args=await chatInstructionArgs('builder',path.join(dir,'probe.json'));
   const file=args[args.indexOf('--extension')+1];
   const loaded=await import('file://'+file+'?'+Date.now());
   const tools:any[]=[];loaded.default({registerTool:(tool:any)=>tools.push(tool)});
   expect(tools.map(t=>t.name)).toEqual(['read','bash','edit','write','grep','find','ls']);
   expect(tools.find(t=>t.name==='grep')!.description).toBe('Искать точное совпадение');
   expect(args).toContain('--no-context-files');
   expect(fs.readFileSync(args[args.indexOf('--append-system-prompt')+1],'utf8')).toContain('ПЕРЕД CLAIM');
   db.prepare('DELETE FROM role_context_overrides WHERE scope=? AND role_key=? AND layer=?').run('role','builder',key);
   db.prepare('DELETE FROM role_context_overrides_history WHERE scope=? AND role_key=? AND layer=?').run('role','builder',key);
   expect(before?.effective ?? '').not.toBe('Искать точное совпадение');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
});
