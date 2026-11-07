// Операции запуска внешнего агента — одним набором через MCP.
//
// Сервер собирает для каждого запуска внешнего агента (чат или узел плана)
// ровно те операции TaskFlow, что этому запуску разрешены, — те же обёртки
// шлюза, что у внутренних ролей. Здесь они регистрируются по runId вместе с
// учёткой участника. Агент получает их как инструменты MCP-сервера
// `taskflow_run` (scripts/run-mcp-bridge.mjs → /api/runs/:runId/tools):
// один набор, без второго списка и без разбора текста ответа.

export interface RunTool {
  name: string;
  description?: string;
  /** JSON Schema аргументов (TypeBox-схема операции). */
  parameters?: unknown;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<any>;
}

interface Entry {
  userId: string;
  tools: RunTool[];
}

const runs = new Map<string, Entry>();
let callCounter = 0;

/** Зарегистрировать операции запуска. Возвращает снятие регистрации. */
export function registerRunTools(runId: string, userId: string, tools: RunTool[]): () => void {
  const entry = { userId, tools };
  runs.set(runId, entry);
  return () => {
    if (runs.get(runId) === entry) runs.delete(runId);
  };
}

/** Операции запуска для этого участника; чужой или закрытый запуск — null. */
export function runToolsFor(runId: string, userId: string): RunTool[] | null {
  const entry = runs.get(runId);
  return entry && entry.userId === userId ? entry.tools : null;
}

/** Описание операции в виде инструмента MCP. */
export function mcpToolOf(tool: RunTool): { name: string; description: string; inputSchema: unknown } {
  const schema = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} };
  return { name: tool.name, description: tool.description ?? "", inputSchema: schema };
}

/** Вызов операции: результат в форме ответа MCP `tools/call`. Ошибка операции — isError, не исключение. */
export async function callRunTool(
  tools: RunTool[],
  runId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `операции ${name} нет или она этому запуску не разрешена` }], isError: true };
  try {
    callCounter += 1;
    const result = await tool.execute(`${runId}:mcp:${callCounter}`, args);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : ""))
      .join("\n")
      .trim();
    return { content: [{ type: "text", text: text || JSON.stringify(result ?? null) }], isError: false };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}
