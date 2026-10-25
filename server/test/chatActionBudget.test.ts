import {it,expect,vi} from "vitest";
import {guardChatActions,configuredChatActionLimit} from "../src/runtime/chatActionBudget.js";

it("настроенный бюджет запрещает лишнее действие до побочного эффекта и сообщает об исчерпании один раз",async()=>{
 const execute=vi.fn(async()=>"ok"), exhausted=vi.fn();
 const [tool]=guardChatActions([{name:"bash",execute}],2,exhausted);
 await tool.execute();await tool.execute();
 await expect(tool.execute()).rejects.toThrow(/исчерпан/);
 await expect(tool.execute()).rejects.toThrow(/исчерпан/);
 expect(execute).toHaveBeenCalledTimes(2);expect(exhausted).toHaveBeenCalledTimes(1);
});
it("управление планом и итог доступны после бюджета, новые действия закрыты",async()=>{
 const execute=vi.fn(async()=>"ok"), exhausted=vi.fn();
 const tools=guardChatActions(["bash","taskflow_work_item_submit","taskflow_work_plan","taskflow_chat_reply","taskflow_tools"].map(name=>({name,execute})),1,exhausted);
 await tools[0].execute();await expect(tools[0].execute()).rejects.toThrow();
 for(const tool of tools.slice(1))await tool.execute();
 expect(execute).toHaveBeenCalledTimes(5);
});
it("без согласованного числа новый предел не включается",()=>{
 expect(configuredChatActionLimit(undefined)).toBeNull();
 for(const value of ["0","-1","abc","2.5"])expect(configuredChatActionLimit(value)).toBeNull();
 expect(configuredChatActionLimit("3")).toBe(3);
});
it("без лимита прежние инструменты сохраняют поведение",async()=>{
 const original={name:"bash",execute:vi.fn(async()=>"ok")};
 const tools=guardChatActions([original],null,vi.fn());
 expect(tools[0]).toBe(original);await tools[0].execute();
});
