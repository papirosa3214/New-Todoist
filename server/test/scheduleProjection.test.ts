import { describe, it, expect } from "vitest";
import { projectRuns } from "../src/runtime/schedules/projection.js";
import { nextRunAfter, type ScheduleRule } from "../src/runtime/schedules/rules.js";
const rule: ScheduleRule = { kind: "daily", expr: null, timeLocal: "09:00", timezone: "Europe/Moscow", anchor: {year: 2026, month: 10, day: 23} };
const dates = (r: ScheduleRule, next: string, start: string, end: string) => projectRuns(r, new Date(next), new Date(start), new Date(end)).map(x => x.toISOString());
describe("проекция расписания без создания карточек", () => {
 it("включает левую границу, исключает правую", () => {
  expect(dates(rule, "2026-10-23T06:00Z", "2026-10-23T06:00Z", "2026-10-25T06:00Z")).toEqual(["2026-10-23T06:00:00.000Z", "2026-10-24T06:00:00.000Z"]);
 });
 it("интервал сохраняет фазу next_run_at при просмотре далёкого месяца", () => {
  expect(dates({...rule, kind:"interval", expr:"15m"}, "2026-10-23T06:07Z", "2026-11-01T06:00Z", "2026-11-01T06:40Z")).toEqual(["2026-11-01T06:07:00.000Z", "2026-11-01T06:22:00.000Z", "2026-11-01T06:37:00.000Z"]);
 });
 it("31-е число в коротком месяце совпадает с серверным запуском", () => {
  expect(dates({...rule, kind:"monthly", expr:"31"}, "2027-01-31T06:00Z", "2027-02-01T00:00Z", "2027-04-01T00:00Z")).toEqual(["2027-02-28T06:00:00.000Z", "2027-03-31T06:00:00.000Z"]);
 });
 it("сохраняет местное время при переходе DST", () => {
  expect(dates({...rule, timezone:"Europe/Berlin"}, "2026-10-24T07:00Z", "2026-10-24T00:00Z", "2026-10-27T00:00Z")).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
 });
 it("не создаёт фиктивное прошлое до первого запуска", () => {
  expect(dates(rule,"2026-10-25T06:00Z","2026-10-23T00:00Z","2026-10-25T00:00Z")).toEqual([]);
 });
 it("разовая автоматизация имеет только одно вхождение", () => {
  const once = {...rule, kind: "once" as ScheduleRule["kind"], expr:"2026-10-24"};
  expect(nextRunAfter(once,new Date("2026-10-24T06:00Z"))).toBeNull();
  expect(dates(once,"2026-10-24T06:00Z","2026-10-23T00:00Z","2026-11-01T00:00Z")).toEqual(["2026-10-24T06:00:00.000Z"]);
 });
});
