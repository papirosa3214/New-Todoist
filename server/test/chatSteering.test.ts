import {describe,it,expect,vi} from "vitest";
import {registerChatSteering,offerChatSteering} from "../src/runtime/chatSteering.js";
import {PLANNING_TOOLS} from "../src/runtime/chatWorkMode.js";

function fixture(chatId="a",roleId="r") {
 let finish!:(ok:boolean)=>void;
 const outcome=new Promise<boolean>(r=>finish=r);
 const steer=vi.fn(async (_text:string)=>{});
 const run=registerChatSteering({chatId,roleId,steer,outcome});
 return {run,steer,finish};
}
describe("уточнения во время хода",()=>{
 it("передаёт сразу, но подтверждает только после потребления и сохранения ответа",async()=>{
  const {run,steer,finish}=fixture();
  const receipt=await offerChatSteering("a","r","m",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"новое условие"});
  expect(steer).toHaveBeenCalledOnce();
  expect(receipt).not.toBeNull();
  run.observe({type:"message_start",message:{role:"user",content:[{type:"text",text:steer.mock.calls[0][0]}]}});
  run.close();
  expect(await receipt!.consumed).toBe(true);
  let done=false;receipt!.outcome.then(()=>done=true);
  await Promise.resolve();expect(done).toBe(false);
  finish(true);expect(await receipt!.outcome).toBe(true);
 });
 it("сохраняет порядок и дедупликацию",async()=>{
  const {run,steer,finish}=fixture();
  const a=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"первое"});
  const duplicate=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"первое"});
  await offerChatSteering("a","r","2",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"второе"});
  expect(duplicate).toBe(a);expect(steer).toHaveBeenCalledTimes(2);
  expect(steer.mock.calls[0][0]).toContain("первое");
  expect(steer.mock.calls[1][0]).toContain("второе");
  run.close();finish(false);
 });
 it("не теряет сообщение между финальным ответом и закрытием",async()=>{
  const {run,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"слишком поздно"});
  run.close();finish(true);
  expect(await receipt!.consumed).toBe(false);
  expect(await offerChatSteering("a","r","2",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"после закрытия"})).toBeNull();
 });
 it("не достаётся другой роли",async()=>{
  const {run,steer,finish}=fixture();
  expect(await offerChatSteering("a","other","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"x"})).toBeNull();
  expect(steer).not.toHaveBeenCalled();run.close();finish(false);
 });
 it("уточнение из другого чата доходит до текущего хода роли",async()=>{
  const {run,steer,finish}=fixture("chat-a","r");
  const receipt=await offerChatSteering("chat-b","r","1",{from:"Максим",chatId:"chat-b",chatTitle:"Чат",body:"из соседнего чата"});
  expect(receipt).not.toBeNull();
  expect(steer).toHaveBeenCalledOnce();
  expect(steer.mock.calls[0][0]).toContain("из соседнего чата");
  // Ответ из другого чата автору — отдельным вызовом.
  expect(steer.mock.calls[0][0]).toContain("taskflow_chat_reply");
  run.observe({type:"message_start",message:{role:"user",content:[{type:"text",text:steer.mock.calls[0][0]}]}});
  run.close();
  expect(await receipt!.consumed).toBe(true);
  finish(true);
 });
 it("уточнение из своего чата идёт в свой ход, а не в чужой",async()=>{
  const a=fixture("chat-a","r");const b=fixture("chat-b","r");
  const receipt=await offerChatSteering("chat-a","r","1",{from:"Максим",chatId:"chat-a",chatTitle:"Чат",body:"свой чат"});
  expect(receipt).not.toBeNull();
  expect(a.steer).toHaveBeenCalledOnce();
  expect(b.steer).not.toHaveBeenCalled();
  // Тот же чат — отдельного вызова ответа не требуется.
  expect(a.steer.mock.calls[0][0]).not.toContain("taskflow_chat_reply");
  a.run.close();b.run.close();a.finish(false);b.finish(false);
 });
 it("при двух ходах в разных чатах уточнение не подмешивается молча",async()=>{
  const a=fixture("chat-a","r");const b=fixture("chat-b","r");
  expect(await offerChatSteering("chat-c","r","1",{from:"Максим",chatId:"chat-c",chatTitle:"Чат",body:"неоднозначно"})).toBeNull();
  expect(a.steer).not.toHaveBeenCalled();expect(b.steer).not.toHaveBeenCalled();
  a.run.close();b.run.close();a.finish(false);b.finish(false);
 });
 it("доставка подтверждается, когда SDK принял ввод",async()=>{
  const {run,steer,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"x"});
  let delivered:boolean|null=null;receipt!.delivered.then(v=>{delivered=v;});
  await Promise.resolve();await Promise.resolve();
  expect(delivered).toBe(null);
  run.observe({type:"message_start",message:{role:"user",content:[{type:"text",text:steer.mock.calls[0][0]}]}});
  await Promise.resolve();await Promise.resolve();
  expect(delivered).toBe(true);
  run.close();finish(false);
 });
 it("непрочитанный ввод не считается доставленным",async()=>{
  const {run,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"x"});
  let delivered:boolean|null=null;receipt!.delivered.then(v=>{delivered=v;});
  run.close();finish(false);
  await Promise.resolve();await Promise.resolve();
  expect(delivered).toBe(false);
 });
 it("при отказе SDK сохраняет обычную доставку",async()=>{
  const {run,steer,finish}=fixture();steer.mockRejectedValueOnce(new Error("closed"));
  expect(await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"x"})).toBeNull();
  run.close();finish(false);
 });
 it("не считает ошибочный ход успешно доставленным",async()=>{
  const {run,steer,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1",{from:"Максим",chatId:"a",chatTitle:"Чат",body:"x"});
  run.observe({type:"message_start",message:{role:"user",content:[{type:"text",text:steer.mock.calls[0][0]}]}});
  run.close();finish(false);
  expect(await receipt!.consumed).toBe(true);expect(await receipt!.outcome).toBe(false);
 });
});
describe("память при планировании",()=>{
 it("разрешает чтение памяти без записи",()=>{
  expect(PLANNING_TOOLS).toContain("taskflow_recall");
  expect(PLANNING_TOOLS).not.toContain("taskflow_remember");
 });
});
