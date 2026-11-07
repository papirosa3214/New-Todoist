import {buildApp} from "../../src/index.js";
import {it,expect,beforeAll,afterAll} from "vitest";
import db from "../../src/db.js";
import {checkRoleLoad} from "../../src/lib/roleLoadWatcher.js";
let app:any;
beforeAll(async()=>{app=await buildApp();});
afterAll(async()=>{await app.close();});
it("пробует реальную выборку и откатывает временные карточки и запуски",()=>{
 const before=(db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n;
 expect(checkRoleLoad()).toEqual({ok:true});
 expect((db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n).toBe(before);
 expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE id LIKE 'role-load-probe-%'").get() as any).n).toBe(0);
});
