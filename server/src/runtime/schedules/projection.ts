import { nextRunAfter, parseIntervalMinutes, type ScheduleRule } from "./rules.js";
/** Read-only calendar expansion. Half-open range; interval keeps the next_run_at phase. */
export function projectRuns(rule: ScheduleRule, next: Date, from: Date, until: Date): Date[] {
 if (![next,from,until].every(d=>Number.isFinite(d.getTime())) || until <= from) return [];
 let cursor = next;
 if (cursor < from) {
  if (rule.kind === "interval") {
   const step = (parseIntervalMinutes(rule.expr) ?? 0) * 60_000;
   if (!step) return [];
   cursor = new Date(cursor.getTime() + Math.ceil((from.getTime()-cursor.getTime())/step)*step);
  } else {
   const candidate = nextRunAfter(rule, new Date(from.getTime()-1));
   if (!candidate) return [];
   cursor = candidate;
  }
 }
 const out: Date[] = [];
 while (cursor < until) {
  if (out.length >= 12000) throw new Error("слишком много запусков: уменьшите диапазон");
  out.push(cursor);
  const following = nextRunAfter(rule,cursor);
  if (!following || following <= cursor) break;
  cursor=following;
 }
 return out;
}
