import { beforeAll,afterAll,it,expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import db from '../src/db.js';
import { addClient,removeClient } from '../src/ws.js';
import { clearActivity } from '../src/routes/activity.js';
import { markReadyForPickup } from './helpers.js';
let app:FastifyInstance,task:string,ownerID:string,token:string;
const messages:any[]=[];
const ownerMessages:any[]=[];
const ownerSocket={readyState:1,send:(s:string)=>ownerMessages.push(JSON.parse(s))};
const socket={readyState:1,send:(s:string)=>messages.push(JSON.parse(s))};
beforeAll(async()=>{
 app=await buildApp();
 const o=(await app.inject({method:'POST',url:'/api/auth/register',payload:{name:'EnergyOwner',email:'energy-owner@test.local',password:'password123'}})).json();
 ownerID=o.user.id;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerID);
 const a=(await app.inject({method:'POST',url:'/api/auth/register',payload:{name:'EnergyAgent',email:'energy-agent@test.local',password:'password123'}})).json();token=a.token;db.prepare("UPDATE users SET type='ai' WHERE id=?").run(a.user.id);
 task=(await app.inject({method:'POST',url:'/api/tasks',headers:{authorization:`Bearer ${o.token}`},payload:{title:'Energy tail',assignee_id:a.user.id}})).json().task.id;
 markReadyForPickup(task);
 expect((await app.inject({method:'POST',url:`/api/tasks/${task}/claim`,headers:{authorization:`Bearer ${token}`},payload:{}})).statusCode).toBe(200);
 addClient(ownerID,socket);addClient("u1",ownerSocket);
});
afterAll(async()=>{clearActivity(task);removeClient(ownerID,socket);removeClient("u1",ownerSocket);await app.close()});
it('delivers the last action of a burst without a client polling request',async()=>{
 for(const target of ['first.ts','last.ts']) expect((await app.inject({method:'POST',url:`/api/tasks/${task}/activity`,headers:{authorization:`Bearer ${token}`},payload:{kind:'read',target}})).statusCode).toBe(200);
 await new Promise(r=>setTimeout(r,2200));
 const events=messages.filter(m=>m.type==='task:activity');
 expect(ownerMessages.filter(m=>m.type==='task:activity')).toHaveLength(2);
 expect(events).toHaveLength(2);expect(events.at(-1).total).toBe(2);expect(events.at(-1).target).toBe('last.ts');
});

it('clears a pending activity event when the buffer closes',async()=>{
 messages.length=0;
 await app.inject({method:'POST',url:`/api/tasks/${task}/activity`,headers:{authorization:`Bearer ${token}`},payload:{kind:'read',target:'cancelled.ts'}});
 messages.length=0;clearActivity(task);
 await new Promise(r=>setTimeout(r,2200));
 expect(messages.filter(m=>m.type==='task:activity')).toHaveLength(0);
});
