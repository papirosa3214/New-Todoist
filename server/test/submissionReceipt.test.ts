import { describe, expect, it } from "vitest";
import { requireSubmissionReceipt } from "../src/lib/submissionReceipt.js";
describe("Отбивка сдачи",()=>{
 const proof={confirmed:true,authority:"primary",subtask_id:"step",artifact_id:"artifact",confirmed_at:"2026-10-08 00:00:00"};
 it("требует сохранённый результат именно своего этапа и артефакта",()=>{
  expect(requireSubmissionReceipt(proof,"step","artifact")).toEqual(proof);
  for(const invalid of [null,{}, {...proof,confirmed:false}, {...proof,authority:"sandbox"}, {...proof,subtask_id:"other"},{...proof,artifact_id:"old"},{...proof,confirmed_at:null}]) expect(()=>requireSubmissionReceipt(invalid,"step","artifact")).toThrow("Сдача не подтверждена");
 });
});
