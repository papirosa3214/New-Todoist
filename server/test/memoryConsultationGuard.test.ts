import {expect,it} from "vitest";
import {MemoryConsultationGuard} from "../src/runtime/memoryConsultationGuard.js";
it("reminds exactly on tenth call and only once",()=>{
 const g=new MemoryConsultationGuard();
 for(let i=1;i<10;i++) expect(g.observe("read",{})).toBeNull();
 expect(g.observe("read",{})).toContain("10");
 for(let i=0;i<30;i++) expect(g.observe("read",{})).toBeNull();
});
for(const tool of ["taskflow_recall","taskflow_kb_search"]) it(tool+" suppresses reminder including tenth call",()=>{
 const g=new MemoryConsultationGuard();
 for(let i=0;i<9;i++)g.observe("read",{});
 expect(g.observe(tool,{query:"queue"})).toBeNull();
 expect(g.observe("read",{})).toBeNull();
});
it("gateway invoke counts but describe and discover do not",()=>{
 for(const action of ["describe","discover","invoke"]){
 const g=new MemoryConsultationGuard();
 g.observe("taskflow",{action,operation:"taskflow_recall"});
 for(let i=0;i<8;i++)g.observe("read",{});
 expect(Boolean(g.observe("read",{}))).toBe(action!=="invoke");
 }
});
it("writing memory and mentioning recall in shell text are not consultations",()=>{
 const g=new MemoryConsultationGuard();
 g.observe("taskflow_remember",{});
 g.observe("bash",{command:"echo taskflow_recall"});
 for(let i=0;i<7;i++)g.observe("read",{});
 expect(g.observe("read",{})).toBeTruthy();
});
it("new turn has its own budget",()=>{
 const g=new MemoryConsultationGuard();g.observe("taskflow_recall",{});
 const next=new MemoryConsultationGuard();
 for(let i=0;i<9;i++)next.observe("read",{});
 expect(next.observe("read",{})).toBeTruthy();
});
