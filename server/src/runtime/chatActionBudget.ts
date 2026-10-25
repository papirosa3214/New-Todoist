/** Optional action ceiling. No new production default before owner approval. */
export function configuredChatActionLimit(raw = process.env.TASKFLOW_CHAT_MAX_ACTIONS): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
const CONTROL = new Set(["taskflow_work_plan", "taskflow_work_item_submit", "taskflow_chat_reply", "taskflow_tools"]);
export function guardChatActions<T extends { name: string; execute: (...args: any[]) => any }>(
  tools: T[], limit: number | null, onExhausted: () => void,
): T[] {
  if (limit === null) return tools;
  let used = 0, exhausted = false;
  return tools.map(tool => CONTROL.has(tool.name) ? tool : {
    ...tool,
    execute: async (...args: any[]) => {
      if (used >= limit) {
        if (!exhausted) { exhausted = true; onExhausted(); }
        throw Object.assign(new Error("Бюджет действий исчерпан: новые действия не выполняются"), {code: "CHAT_ACTION_BUDGET"});
      }
      used++;
      return tool.execute(...args);
    },
  });
}
