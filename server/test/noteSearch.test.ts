import {it, expect, beforeAll, afterAll} from "vitest";
import {buildApp} from "../src/index.js";
import crypto from "node:crypto";
import db from "../src/db.js";
import {searchNotes, queryStems} from "../src/lib/noteSearch.js";
let app:any;
beforeAll(async()=>{app=await buildApp();});
afterAll(async()=>app.close());
const doc=(text:string)=>JSON.stringify({type:"doc",content:[{type:"paragraph",content:[{type:"text",text}]}]});
function note(title:string,text:string){const id="n_"+crypto.randomUUID();db.prepare("INSERT INTO user_notes(id,title,content) VALUES(?,?,?)").run(id,title,doc(text));return id;}
it("находит заметку по словам в другой форме и отдаёт отрывок с id",()=>{
 const marker="кваркозавр"+crypto.randomUUID().slice(0,6);
 const a=note("Регламент архивации","Задачи с пометкой "+marker+" архивируются вместе с дочерними карточками.");
 note("Посторонняя заметка","Ничего общего с запросом.");
 const found=searchNotes("архивирование "+marker+"а",5);
 expect(found[0].id).toBe(a);
 expect(found[0].text).toContain(marker);
 expect(found[0].title).toBe("Регламент архивации");
});
it("пустой и бессодержательный запрос ничего не возвращает",()=>{
 expect(searchNotes("  ")).toEqual([]);
 expect(queryStems("что это и как")).toEqual([]);
 expect(searchNotes("зюзюбрик"+crypto.randomUUID())).toEqual([]);
});
