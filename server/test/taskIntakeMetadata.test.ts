import {describe,it,expect} from "vitest";
import {parseIntakeMetadata} from "../src/lib/taskIntakeMetadata.js";
const labels=[{id:"work",name:"Работа"}];
describe("общие поля постановки",()=>{
  it("сохраняет дату, время, метки и явного владельца",()=>{
    expect(parseIntakeMetadata({due_date:"2026-10-01",start_time:"10:00",labels:["работа","Работа"],assignee:"self"},labels)).toEqual({dueDate:"2026-10-01",startTime:"10:00",labelIds:["work"],selfAssigned:true,question:null});
  });
  it("отделяет время от старого поля due_date",()=>{
    expect(parseIntakeMetadata({due_date:"2026-10-01 10:00"},labels)).toMatchObject({dueDate:"2026-10-01",startTime:"10:00",question:null});
  });
  it("не выдумывает неизвестную метку и не принимает невозможную дату",()=>{
    const m=parseIntakeMetadata({due_date:"2026-02-30",labels:["Несуществующая"]},labels);
    expect(m.dueDate).toBeNull();expect(m.labelIds).toEqual([]);expect(m.question).toBeTruthy();
  });
  it("не ставит время без даты",()=>{
    expect(parseIntakeMetadata({start_time:"10:00"},labels)).toMatchObject({startTime:null});
    expect(parseIntakeMetadata({start_time:"10:00"},labels).question).toBeTruthy();
  });
});
