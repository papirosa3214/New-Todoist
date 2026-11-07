const fs = require('fs');
const path = '/Users/max/.minimax-agent/projects/New-Todoist/src/lib/useTaskActivity.ts';
let code = fs.readFileSync(path, 'utf8');

const target = `export function shouldExplain(
  event: { kind?: string; diff?: string },
  lastAt: number,
  now: number,
): boolean {
  if (event.kind !== "edit") return false;
  if (!event.diff || event.diff.trim().length < 10) return false;
  return now - lastAt >= EXPLAIN_EVERY_MS;
}`;

const replacement = `export function shouldExplain(
  event: TaskActivityEvent,
  lastAt: number,
  now: number,
): boolean {
  const isStateChange =
    event.text.includes("review") ||
    event.text.includes("blocked") ||
    event.text.toLowerCase().includes("проверк") ||
    event.text.toLowerCase().includes("ошибк") ||
    event.text.toLowerCase().includes("заблокирован");

  if (!isStateChange) {
    if (event.kind !== "edit") return false;
    if (!event.diff || event.diff.trim().length < 10) return false;
    if (now - lastAt < EXPLAIN_EVERY_MS) return false;
  }

  return true;
}`;

code = code.replace(target, replacement);
fs.writeFileSync(path, code);
