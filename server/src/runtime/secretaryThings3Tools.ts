import { Type } from "typebox";
import contract from "./things_tools_contract.json" with { type: "json" };
import { listMachines } from "../host/machines.js";
import { isMachineOnline, runOperation } from "../host/gateway.js";
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
export const THINGS3_TOOLS = contract.tools.map((tool) => tool.name);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** Машина, на которой живёт Things3: любая разрешённая и онлайн. */
function машинаСВещами(): { id: string; name: string } | null {
  for (const машина of listMachines()) {
    if (машина.revoked_at) continue;
    if (!/^(darwin|macos|mac)$/i.test(машина.platform ?? "")) continue;
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
        "Things 3 владельца через TaskFlow Host на Mac. Структурированное чтение и поддержанные записи. " +
        "Недоступные свойства не означают пустые: смотри availability в записи. " +
        "Для неподдержанной записи инструмент возвращает причину и требуемую настройку. " +
        "Повторы нельзя изменять через публичный API Things. " +
        contract.tools.map((tool) => `${tool.name}: ${tool.description}`).join("; "),
      parameters: Type.Unsafe<{ tool: string; arguments?: Record<string, unknown> }>({
        anyOf: contract.tools.map((tool) => ({
          type: "object",
          properties: { tool: { const: tool.name, type: "string" }, arguments: tool.inputSchema },
          required: ["tool"],
          additionalProperties: false,
        })),
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
        const data = ответ.data as { ok?: boolean; error?: string; tool?: string; result?: string } | undefined;
        if (data?.ok === false) throw new Error(`Things3: ${data.error ?? data.result ?? "операция не выполнена"}`);
        return text(data?.result ?? JSON.stringify(ответ));
      },
    },
  ];
}