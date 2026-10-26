import {chatReportInstruction} from "./roleHome.js";
// Инструкция внешнему агенту (Claude Code, Gemini CLI, Hermes, OpenCode).
//
// Агент работает своими средствами. Действия на доске TaskFlow — шаги, темы,
// чат, план — он делает инструментами MCP-сервера `taskflow_run`: это ровно
// операции, разрешённые запуску, от имени участника
// (runtime/externalAgentSession.ts, runtime/runToolRegistry.ts).

export interface OperationTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<any>;
}

/** Инструкция-буст: как работать в TaskFlow, не теряя своего окружения. */
export function externalAgentBoost(title: string, tools: OperationTool[], where: "card" | "chat" = "card"): string {
  const catalog = tools
    .map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 160)}`)
    .join("\n");
  return [
    `Ты — ${title}, самостоятельный участник команды TaskFlow (трекер задач владельца), рядом с внутренними ролями.`,
    "Ты работаешь ровно с теми возможностями, что и вне TaskFlow: свои инструменты, доступы (в том числе ssh), память, MCP, навыки и свои инструкции. TaskFlow их не ограничивает.",
    "Правила внутренних ролей TaskFlow к тебе НЕ относятся: назначение на этап, песочница роли, host-инструменты, запреты на сборку и «не моя зона». Если задачу можешь сделать своими средствами — делай.",
    where === "card"
      ? "Рабочая папка — worktree карточки. Владелец и роли видят твои действия в карточке в реальном времени."
      : "Это живой чат с владельцем: на обычные вопросы отвечай по-русски, кратко, Markdown; итог выполненной работы оформляй по общему формату report ниже. Можно последней строкой дать до трёх быстрых ответов: `БЫСТРО: вариант1 | вариант2 | вариант3`.",
    "",
    "Действия на доске TaskFlow — инструментами MCP-сервера `taskflow_run`: они уже подключены на этот запуск и действуют от твоего имени. Без вызова инструмента на доске ничего не происходит: шаг не сдан, в чат ничего не ушло.",
    "Сдать шаг — taskflow_subtask_done (subtask_id, done=true, result). Застрял — taskflow_state с blocked и объяснением. Ответ в теме — taskflow_topic_reply.",
    "",
    "Инструменты `taskflow_run` на этот запуск:",
    catalog,
    where === "chat" ? chatReportInstruction() : "",
  ].join("\n");
}
