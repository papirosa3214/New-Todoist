import { Type } from "typebox";
import { listMachines } from "../host/machines.js";
import { isMachineOnline, resolveMachine, runOperation } from "../host/gateway.js";
import type { Tool } from "./universalTaskflow.js";

/**
 * Things3 для Помощника владельца (18.10.2026).
 *
 * Зачем так: Things3 — macOS-приложение, роль живёт на .110 и к нему не
 * достаётся ни как. Хост на маке уже умеет отвечать на операции шлюза, и
 * логика доступа к вещам написана ровно один раз — `things_mcp_server.py` на
 * маке. Вторая копия на сервере разошлась бы с оригиналом при первом же
 * изменении списка списков.
 *
 * Поэтому здесь нет своего кода доступа: инструмент только спрашивает у
 * хоста операцию `things3` и отдаёт ответ роли как есть.
 *
 * Кому: только secretary. Это личный помощник владельца — тот же набор
 * полномочий, что у почты (`secretaryMailTools`), и тот же принцип: доступ
 * к личному календарю/делам есть у помощника, а не у всей команды.
 */

/** Инструменты `things_mcp_server.TOOLS`. Хост отвергнет имя не из списка. */
export const THINGS3_TOOLS = [
  "things_today",
  "things_inbox",
  "things_upcoming",
  "things_anytime",
  "things_someday",
  "things_search",
  "things_projects",
  "things_areas",
  "things_add",
  "things_complete",
  "things_show",
] as const;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** Машина, на которой живёт Things3: любая разрешённая и онлайн. */
function машинаСВещами(): { id: string; name: string } | null {
  for (const машина of listMachines()) {
    if (машина.revoked_at) continue;
    if (!isMachineOnline(машина.id)) continue;
    return { id: машина.id, name: машина.name };
  }
  return null;
}

export interface Things3ToolContext {
  role: string;
  taskId?: string;
  subtaskId?: string;
  chatId?: string;
  messageId?: string;
}

export function secretaryThings3Tools(context: Things3ToolContext): Tool[] {
  return [
    {
      name: "taskflow_things3",
      description:
        "Список дел в Things3 владельца. tool — что сделать: things_today (на сегодня), " +
        "things_inbox (входящие), things_upcoming (с дедлайном), things_anytime, things_someday, " +
        "things_projects, things_areas, things_search (поиск по названию и заметкам). " +
        "Создание и закрытие: things_add (title обязателен, list: inbox|today|upcoming|anytime|someday, " +
        "плюс notes, due, when), things_complete, things_show (открыть в приложении). " +
        "Пример: {tool: \"things_today\"} или {tool: \"things_add\", arguments: {title: \"купить хлеб\", list: \"today\"}}. " +
        "Доступно только тебе — Помощнику владельца.",
      parameters: Type.Object({
        tool: Type.String({
          description: "Инструмент Things3",
          enum: THINGS3_TOOLS as unknown as string[],
        }),
        arguments: Type.Optional(
          Type.Unsafe<Record<string, unknown>>({ description: "Поля выбранного инструмента" }),
        ),
      }),
      execute: async (_id: string, p: { tool: string; arguments?: Record<string, unknown> }) => {
        const имя = String(p.tool ?? "").trim();
        if (!(THINGS3_TOOLS as readonly string[]).includes(имя)) {
          throw new Error(`«${имя}» — не инструмент Things3. Доступны: ${THINGS3_TOOLS.join(", ")}`);
        }

        const машина = машинаСВещами();
        // Не выдаём «инструмент недоступен» молча: роль должна знать, что
        // мака нет, иначе решит, что дел не нашлось.
        if (!машина) {
          throw new Error(
            "Машина с Things3 сейчас офлайн (посмотри taskflow_hosts). Записать и прочитать дела не выйдет.",
          );
        }

        const ответ = (await runOperation(машина.id, "things3", {
          tool: имя,
          arguments: p.arguments ?? {},
        })) as any;

        if (!ответ?.ok) throw new Error(`Хост не выполнил: ${String(ответ?.error ?? "без текста")}`);
        const data = ответ.data as { tool?: string; result?: string } | undefined;
        return text(data?.result ?? JSON.stringify(ответ));
      },
    },
  ];
}