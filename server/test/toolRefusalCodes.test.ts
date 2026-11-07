import {it,expect} from "vitest";
import {STEERING_REFUSAL} from "../src/runtime/serverRefusal.js";
import {
 isToolNotInCatalogText,
 serviceRefusalCodeOf,
 TOOL_NOT_CONNECTED,
 STEERING_REFUSAL_CODE,
} from "../src/runtime/toolRefusalCodes.js";

// D1 карточки e73e7314: «not found» в любом тексте объявляло отказ служебным.
// Так настоящая ошибка аргументов («task not found», «subscription not found»)
// вычиталась из errors в toolOutcomeStats, и сторож переставал видеть цикл
// неверных вызовов — роль могла крутить один и тот же промах без остановки.
it("текст «инструмента нет в каталоге» распознаётся как неподключённая операция",()=>{
 for(const text of [
  "Tool taskflow_remember not found",
  'Tool "taskflow_remember" not found',
  "Tool `taskflow_remember` not found",
  "Нужный инструмент не найден в каталоге сессии",
 ]){
  expect(isToolNotInCatalogText(text)).toBe(true);
  expect(serviceRefusalCodeOf({text})).toBe(TOOL_NOT_CONNECTED);
 }
});

it("настоящая ошибка аргументов со словами not found не считается служебным отказом",()=>{
 for(const text of [
  "POST /api/tasks/abc → 404: task not found",
  "subscription not found",
  "plan not found",
  "wake script not found at /tmp/x.sh",
  "Tool result's tool id not found",
  "INVALID_ARGUMENTS: /command: Expected string, received undefined",
 ]){
  expect(isToolNotInCatalogText(text)).toBe(false);
  expect(serviceRefusalCodeOf({text})).toBeNull();
 }
});

it("служебные отказы сервера по-прежнему опознаются по тексту",()=>{
 expect(serviceRefusalCodeOf({text:STEERING_REFUSAL})).toBe(STEERING_REFUSAL_CODE);
});
