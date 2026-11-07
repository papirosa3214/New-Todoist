/**
 * Замер того, что реально уходит модели в запросе: активный набор инструментов
 * роли, число схем и их объём в символах.
 *
 *   npx tsx scripts/measure-tool-schemas.mts [--role builder] [--server-dir <путь>]
 *                                            [--mode chat|work] [--no-adapters]
 *
 * Адаптеры собираются так же, как в живом ходе (inProcessRun): Composio и
 * внешние MCP (инфрапанель + граф кода), а для помощника — Things. С --no-adapters
 * внешние адаптеры не поднимаются (замер только встроенных операций).
 *
 * Скрипт печатает одну строку JSON и ничего не меняет: база временная, сеть
 * только на чтение (список инструментов внешних мостов).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
};
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(arg("server-dir", join(here, "..")));
const role = arg("role", "builder")!;
const mode = arg("mode", "chat")!;
const withAdapters = !process.argv.includes("--no-adapters");

process.env.DB_PATH ??= join(mkdtempSync(join(tmpdir(), "measure-tools-")), "tools.db");

const { migrate } = await import(join(serverDir, "src/db.ts"));
const { runMigrations } = await import(join(serverDir, "src/migrations.ts"));
const { buildRoleToolCatalog } = await import(join(serverDir, "src/runtime/roleToolCatalog.ts"));
const { connectRoleComposio } = await import(join(serverDir, "src/runtime/composioRuntime.ts"));
const { connectRoleMcp } = await import(join(serverDir, "src/runtime/graftMcp.ts"));
const { secretaryThings3Tools } = await import(join(serverDir, "src/runtime/secretaryThings3Tools.ts"));

migrate();
runMigrations();

const adapters: any[] = [];
const sources: Record<string, number | string> = {};
if (withAdapters) {
  const composio = await connectRoleComposio(role, "work", "measure").catch((error: any) => {
    sources.composio = `ошибка: ${error instanceof Error ? error.message : String(error)}`;
    return { tools: [] as any[], close: async () => {} };
  });
  sources.composio ??= composio.tools.length;
  const mcp = await connectRoleMcp(role, serverDir).catch((error: any) => {
    sources.mcp = `ошибка: ${error instanceof Error ? error.message : String(error)}`;
    return { tools: [] as any[], close: async () => {} };
  });
  sources.mcp ??= mcp.tools.length;
  const things = role === "secretary" ? secretaryThings3Tools({ role, chatId: "measure", messageId: "measure" }) : [];
  if (role === "secretary") sources.things = things.length;
  adapters.push(...composio.tools, ...mcp.tools, ...things);
}

const wire = (names: string[], tools: any[]) =>
  JSON.stringify(tools.filter(tool => names.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));

const context = mode === "chat" ? { chatId: "measure", messageId: "measure", executionMode: "chat" } : { taskId: "measure", subtaskId: "measure" };
const catalog = buildRoleToolCatalog({ role, mode: "work", runId: "measure", ...context } as any, adapters);
const json = wire(catalog.activeNames, catalog.customTools as any[]);
const schemas = JSON.parse(json) as any[];
const byGroup = new Map<string, { count: number; chars: number }>();
for (const schema of schemas) {
  const group = schema.name.split("_")[0] + "_";
  const row = byGroup.get(group) ?? { count: 0, chars: 0 };
  row.count += 1;
  row.chars += JSON.stringify(schema).length;
  byGroup.set(group, row);
}
const onDemand = /^(todoist_|mcp__composio__|things_)/;
const leaked = (catalog.activeNames as string[]).filter((name: string) => onDemand.test(name));
const registeredByGroup: Record<string, number> = {};
for (const name of catalog.registeredNames as string[]) {
  const group = name.split("_")[0] + "_";
  registeredByGroup[group] = (registeredByGroup[group] ?? 0) + 1;
}

console.log(JSON.stringify({
  роль: role,
  режим: mode,
  адаптеры: withAdapters ? sources : "выключены",
  схем: schemas.length,
  символов: json.length,
  активных_имен: catalog.activeNames.length,
  в_реестре: catalog.registeredNames.length,
  taskflow_tools_активен: (catalog.activeNames as string[]).includes("taskflow_tools"),
  внешние_в_активных: leaked,
  по_группам: Object.fromEntries([...byGroup].sort((a, b) => b[1].chars - a[1].chars)),
  реестр_по_группам: Object.fromEntries(Object.entries(registeredByGroup).sort((a, b) => b[1] - a[1]).slice(0, 12)),
}));
