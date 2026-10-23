import {chatReportInstruction} from "./roleHome.js";
// Действия внешнего агента на доске TaskFlow — без MCP.
//
// Внешний агент работает своими инструментами; TaskFlow ему инструментов не
// выдаёт. Чтобы сдать шаг, написать в чат или поставить блок, агент кладёт в
// ответ блок
//
//   ```taskflow-actions
//   [{"operation": "taskflow_subtask_done", "arguments": {...}}]
//   ```
//
// Сервер выполняет каждую операцию тем же шлюзом, что у внутренних ролей
// (права, лента, правила — от учётки участника), и возвращает итоги агенту
// следующим сообщением той же сессии.

import crypto from "node:crypto";

export interface ExternalAction {
  operation: string;
  arguments: Record<string, unknown>;
}

export interface OperationTool {
  name: string;
  description?: string;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<any>;
}

const BLOCK_RE = /```taskflow-actions\s*\n([\s\S]*?)```/g;

/** Действия из всех блоков `taskflow-actions` ответа. Битый блок — ошибка, а не тишина. */
export function parseActions(text: string): { actions: ExternalAction[]; errors: string[] } {
  const actions: ExternalAction[] = [];
  const errors: string[] = [];
  for (const match of text.matchAll(BLOCK_RE)) {
    let value: unknown;
    try { value = JSON.parse(match[1]); } catch (error) {
      errors.push(`блок taskflow-actions не JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const op = (item as any)?.operation;
      if (typeof op !== "string" || !op) { errors.push("действие без operation"); continue; }
      const args = (item as any).arguments;
      actions.push({ operation: op, arguments: args && typeof args === "object" ? args : {} });
    }
  }
  return { actions, errors };
}

/** Ответ без служебного блока — то, что видит владелец. */
export function stripActions(text: string): string {
  return text.replace(BLOCK_RE, "").trim();
}

function resultText(result: any): string {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join("\n").trim();
  return (text || JSON.stringify(result ?? null)).slice(0, 1500);
}

export async function runActions(actions: ExternalAction[], tools: OperationTool[], runId: string): Promise<string[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const lines: string[] = [];
  for (const [i, action] of actions.entries()) {
    const tool = byName.get(action.operation);
    if (!tool) { lines.push(`${action.operation}: операции нет или она тебе не разрешена`); continue; }
    try {
      lines.push(`${action.operation}: ок — ${resultText(await tool.execute(`${runId}:ext:${i}`, action.arguments))}`);
    } catch (error) {
      lines.push(`${action.operation}: ошибка — ${error instanceof Error ? error.message : String(error)}`.slice(0, 1500));
    }
  }
  return lines;
}

/** Обработчик конца хода: есть действия — выполнить и вернуть итоги агенту; нет — ход окончен. */
export function actionTurnHandler(tools: OperationTool[], runId: string): (text: string) => Promise<string | null> {
  return async (text) => {
    const { actions, errors } = parseActions(text);
    if (!actions.length && !errors.length) return null;
    const lines = [...errors, ...(await runActions(actions, tools, `${runId}:turn:${crypto.randomUUID()}`))];
    return `Итоги действий TaskFlow:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nЕсли что-то не прошло — исправь и пришли новый блок taskflow-actions. Если всё сделано — ответь коротко без блока.`;
  };
}

/** Инструкция-буст: как работать в TaskFlow, не теряя своего окружения. */
export function externalAgentBoost(title: string, tools: OperationTool[], where: "card" | "chat" = "card"): string {
  const catalog = tools
    .map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 160)}`)
    .join("\n");
  return [
    `Ты — ${title}, самостоятельный участник команды TaskFlow (трекер задач владельца), рядом с внутренними ролями.`,
    "Ты работаешь ровно с теми возможностями, что и вне TaskFlow: свои инструменты, доступы (в том числе ssh), память, MCP, скиллы, свои инструкции CLAUDE.md. TaskFlow их не ограничивает.",
    "Правила внутренних ролей TaskFlow к тебе НЕ относятся: назначение на этап, песочница роли, host-инструменты, запреты на сборку и «не моя зона». Если задачу можешь сделать своими средствами — делай.",
    where === "card"
      ? "Рабочая папка — worktree карточки. Владелец и роли видят твои действия в карточке в реальном времени."
      : "Это живой чат с владельцем: на обычные вопросы отвечай по-русски, кратко, Markdown; итог выполненной работы оформляй по общему формату report ниже. Можно последней строкой дать до трёх быстрых ответов: `БЫСТРО: вариант1 | вариант2 | вариант3`.",
    "",
    "Действия на доске TaskFlow — блоком в ответе. Где в задании сказано вызвать taskflow_* (или инструмент taskflow с invoke), положи в ответ:",
    "```taskflow-actions",
    '[{"operation": "<имя операции>", "arguments": { ... }}]',
    "```",
    "Сервер выполнит действия от твоего имени и пришлёт итоги следующим сообщением. Без блока на доске ничего не происходит: шаг не сдан, в чат ничего не ушло.",
    `Если у тебя подключён свой MCP TaskFlow — им тоже можно: на этот запуск он получает твой пропуск и действует от имени «${title}».`,
    "Сдать шаг — taskflow_subtask_done (subtask_id, done=true, result). Застрял — taskflow_state с blocked и объяснением. Ответ в теме — taskflow_topic_reply.",
    "",
    "Доступные операции:",
    catalog,
    where === "chat" ? chatReportInstruction() : "",
  ].join("\n");
}
