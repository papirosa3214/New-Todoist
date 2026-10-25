// Подключение операций по требованию — штатный механизм Pi 0.84.4.
//
// Описания всех операций уходили модели в каждом запросе: 32–56 КБ схем на
// роль (57–113 инструментов), а роль регулярно зовёт 11–17 из них. Pi умеет
// держать в реестре все инструменты, но отдавать модели только активные
// (session.setActiveToolsByName) и расширять набор между запросами.
//
// Здесь: инструмент taskflow_tools. Он показывает индекс доступных операций
// (одна выдача на сессию — дальше индекс живёт в истории) и подключает
// нужные по именам. Права не меняются: в загрузчик попадают только
// операции, которые роль и так имеет право вызывать, а проверка прав
// остаётся в шлюзе на момент вызова.

import { Type } from "typebox";
import type { Tool } from "./universalTaskflow.js";

export const TOOL_LOADER_NAME = "taskflow_tools";

const INDEX_DESCRIPTION_LIMIT = 160;

export type ToolLoader = {
  tool: Tool;
  /** Привязать живую сессию: до этого подключать нечем. */
  attach: (session: any) => void;
};

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-zа-яё0-9_]+/i).filter((w) => w.length >= 2);
}

/** Совпадение по имени и описанию: имя весит больше — там действие. */
function score(tool: Tool, tokens: string[]): number {
  if (!tokens.length) return 0;
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (name === token) total += 8;
    else if (name.includes(token)) total += 4;
    if (description.includes(token)) total += 1;
  }
  return total;
}

export function createToolLoader(options: {
  operations: Tool[];
  matchLimit?: number;
  indexLimit?: number;
}): ToolLoader {
  const matchLimit = options.matchLimit ?? 6;
  const indexLimit = options.indexLimit ?? 120;
  const known = new Map(options.operations.map((tool) => [tool.name, tool]));
  let session: any = null;

  const activeNames = (): string[] => (session?.getActiveToolNames?.() ?? []) as string[];
  const isActive = (name: string): boolean => activeNames().includes(name);

  const activate = (names: string[]): string[] => {
    if (!session) throw new Error("Загрузчик без сессии: подключать инструменты нечем.");
    const current = activeNames();
    const next = [...new Set([...current, ...names])];
    if (next.length !== current.length) session.setActiveToolsByName(next);
    return names;
  };

  const index = (): { name: string; description: string }[] => {
    const active = new Set(activeNames());
    return [...known.values()]
      .filter((tool) => !active.has(tool.name))
      .slice(0, indexLimit)
      .map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(0, INDEX_DESCRIPTION_LIMIT),
      }));
  };

  const tool: Tool = {
    name: TOOL_LOADER_NAME,
    description:
      "Подключить операции TaskFlow, которых сейчас нет в списке инструментов. " +
      "Без параметров — показать индекс доступных операций (одна выдача на сессию). " +
      "names — подключить операции по именам из индекса. query — подобрать по смыслу задачи. " +
      "Закрытое подключить нельзя: возможность не равна разрешению.",
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String(), { minLength: 1 })),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (_id: string, args: any) => {
      const requested = Array.isArray(args?.names) ? args.names.map((n: any) => String(n)) : [];
      const unknown = requested.filter((name: string) => !known.has(name));
      const wanted = requested.filter((name: string) => known.has(name));
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      const tokens = words(query);
      const matched = tokens.length
        ? [...known.values()]
            .map((tool) => ({ tool, score: score(tool, tokens) }))
            .filter((row) => row.score > 0)
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
            .slice(0, Math.min(args?.limit ?? matchLimit, matchLimit))
            .map((row) => row.tool.name)
        : [];
      const toActivate = [...new Set([...wanted, ...matched])].filter((name) => !isActive(name));
      const activated = activate(toActivate);
      const alreadyActive = [...new Set([...wanted, ...matched])].filter(
        (name: string) => isActive(name) && !activated.includes(name),
      );
      const payload = {
        activated,
        already_active: alreadyActive,
        unknown,
        matches: matched,
        available: index(),
        note: activated.length
          ? "Инструменты подключены — вызывай их по именам, схема придёт в следующем запросе."
          : alreadyActive.length
            ? "Эти инструменты уже подключены — вызывай их по именам."
            : "Ничего не подключено: уточни запрос или назови операции из индекса.",
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: { activated } };
    },
  };

  return {
    tool,
    attach: (next: any) => {
      session = next;
    },
  };
}
