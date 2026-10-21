import {describe,it,expect,vi} from "vitest";
import {registerChatSteering,offerChatSteering} from "../src/runtime/chatSteering.js";
import {PLANNING_TOOLS} from "../src/runtime/chatWorkMode.js";

function fixture() {
 let finish!:(ok:boolean)=>void;
 const outcome=new Promise<boolean>(r=>finish=r);
 const steer=vi.fn(async (_text:string)=>{});
 const run=registerChatSteering({chatId:"a",roleId:"r",steer,outcome});
 return {run,steer,finish};
}
describe("уточнения во время хода",()=>{
 it("передаёт сразу, но подтверждает только после потребления и сохранения ответа",async()=>{
  const {run,steer,finish}=fixture();
  const receipt=await offerChatSteering("a","r","m","новое условие");
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
  const a=await offerChatSteering("a","r","1","первое");
  const duplicate=await offerChatSteering("a","r","1","первое");
  await offerChatSteering("a","r","2","второе");
  expect(duplicate).toBe(a);expect(steer).toHaveBeenCalledTimes(2);
  expect(steer.mock.calls[0][0]).toContain("первое");
  expect(steer.mock.calls[1][0]).toContain("второе");
  run.close();finish(false);
 });
 it("не теряет сообщение между финальным ответом и закрытием",async()=>{
  const {run,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1","слишком поздно");
  run.close();finish(true);
  expect(await receipt!.consumed).toBe(false);
  expect(await offerChatSteering("a","r","2","после закрытия")).toBeNull();
 });
 it("не доставляет другому чату или роли",async()=>{
  const {run,steer,finish}=fixture();
  expect(await offerChatSteering("b","r","1","x")).toBeNull();
  expect(await offerChatSteering("a","other","1","x")).toBeNull();
  expect(steer).not.toHaveBeenCalled();run.close();finish(false);
 });
 it("при отказе SDK сохраняет обычную доставку",async()=>{
  const {run,steer,finish}=fixture();steer.mockRejectedValueOnce(new Error("closed"));
  expect(await offerChatSteering("a","r","1","x")).toBeNull();
  run.close();finish(false);
 });
 it("не считает ошибочный ход успешно доставленным",async()=>{
  const {run,steer,finish}=fixture();
  const receipt=await offerChatSteering("a","r","1","x");
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
