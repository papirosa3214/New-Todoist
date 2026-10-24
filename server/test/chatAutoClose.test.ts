import {beforeAll,beforeEach,describe,expect,it} from "vitest";
import db from "../src/db.js";
import {autoCloseStaleRoleChats,chatAutoCloseIdleMinutes} from "../src/runtime/chatAutoClose.js";
beforeAll(()=>db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY,room_kind TEXT,created_at TEXT,updated_at TEXT,closed_at TEXT);
CREATE TABLE chat_messages (id TEXT PRIMARY KEY,chat_id TEXT,created_at TEXT);
CREATE TABLE chat_message_queue (chat_id TEXT,status TEXT);`));
beforeEach(()=>db.exec("DELETE FROM chats; DELETE FROM chat_messages; DELETE FROM chat_message_queue;"));
function room(id:string,kind="dm",updated="-1 minute",message="-31 minutes") {
 db.prepare("INSERT INTO chats VALUES (?,?,datetime('now','-2 hours'),datetime('now',?),NULL)").run(id,kind,updated);
 db.prepare("INSERT INTO chat_messages VALUES (?,?,datetime('now',?))").run("msg-"+id,id,message);
}
describe("30 minutes since the last message",()=>{
 it("closes an old conversation despite a recent metadata update",()=>{
  room("old");expect(autoCloseStaleRoleChats(30)).toBe(1);
  expect((db.prepare("SELECT closed_at FROM chats WHERE id='old'").get() as any).closed_at).toBeTruthy();
 });
 it("keeps a recent message even if updated_at is stale",()=>{
  room("recent","dm","-2 hours","-29 minutes");expect(autoCloseStaleRoleChats(30)).toBe(0);
 });
 it("keeps personal/common chats and in-flight deliveries",()=>{
  room("personal","personal");room("common","common");room("active");
  db.prepare("INSERT INTO chat_message_queue VALUES (?,?)").run("active","picked");
  expect(autoCloseStaleRoleChats(30)).toBe(0);
 });
 it("uses creation time for an empty conversation",()=>{
  room("empty");db.exec("DELETE FROM chat_messages");expect(autoCloseStaleRoleChats(30)).toBe(1);
 });
});
