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

/** Образец правильного вызова операции Things (20.10.2026: Помощник клала
 *  id дела рядом с arguments, а не внутрь, получала «обязательное поле»,
 *  повторяла тот же вызов и записала в память ложную «регрессию шлюза»). */
export function things3CallExample(tool: string): string {
  const schema = contract.tools.find((t) => t.name === tool)?.inputSchema as
    | { required?: string[] }
    | undefined;
  const name = schema ? tool : "things_complete";
  const required = schema ? schema.required ?? [] : ["id_or_title"];
  const inner = Object.fromEntries(required.map((key) => [key, key === "patch" ? { "…": "…" } : "…"]));
  const call = {
    operation: "taskflow_things3",
    arguments: { tool: name, arguments: inner },
  };
  return (
    `Правильный вызов: ${JSON.stringify(call)}. Параметры дела (${required.join(", ") || "нет"}) ` +
    "кладутся внутрь arguments.arguments, а не рядом с tool и не на верхний уровень. " +
    "Исправь вызов по образцу; это ошибка вызова, а не поломка Things или шлюза."
  );
}

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
      invalidArgsHint: (args) => things3CallExample(String(args.tool ?? "")),
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

        // Things3 на маке иногда не отвечает (закрыт или завис). Без следующего шага
        // секретарь повторял тот же вызов (разбор отказов 19.10.2026).
        // Пропущенный параметр — ошибка вызова: повтор как есть ничего не даст.
        if (!ответ?.ok && /обязательное поле|required/i.test(String(ответ?.error ?? ""))) {
          throw new Error(`Хост не выполнил: ${String(ответ?.error)}. ${things3CallExample(имя)}`);
        }
        if (!ответ?.ok) throw new Error(`Хост не выполнил: ${String(ответ?.error ?? "без текста")}. Дальше: повтори этот же вызов один раз; если снова не вышло — не перебирай другие операции Things, сообщи владельцу, что Things3 на маке не отвечает и его нужно открыть или перезапустить.`);
        const data = ответ.data as { ok?: boolean; error?: string; tool?: string; result?: string } | undefined;
        if (data?.ok === false) throw new Error(`Things3: ${data.error ?? data.result ?? "операция не выполнена"}`);
        return text(data?.result ?? JSON.stringify(ответ));
      },
    },
  ];
}