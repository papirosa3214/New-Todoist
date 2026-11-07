/**
 * Живая проверка на настоящем внешнем мосте: операция, которую роль получает
 * из внешнего сервиса (граф кода через `graft mcp`, инфрапанель), в активный
 * набор не входит, подключается через taskflow_tools и исполняется по-настоящему
 * — возвращает данные сервиса, а не «Tool not found».
 *
 *   npx tsx scripts/probe-real-graft.mts --role builder --tool graft_find_code \
 *     --arg query="lazy tool activation" --arg repo=New-Todoist
 *
 * Заглушек нет: адаптер — тот же connectRoleMcp, что поднимает живой ход роли
 * (настоящий stdio-процесс моста). Только чтение, база временная.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argsOf = (name: string): string[] => {
  const out: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === `--${name}` && process.argv[index + 1]) out.push(process.argv[index + 1]);
  });
  return out;
};
const arg = (name: string, fallback?: string) => argsOf(name)[0] ?? fallback;

const serverDir = resolve(arg("server-dir", join(dirname(fileURLToPath(import.meta.url)), "..")));
const role = arg("role", "builder")!;
const toolName = arg("tool", "graft_find_code")!;
const callArgs: Record<string, unknown> = {};
for (const pair of argsOf("arg")) {
  const [key, ...rest] = pair.split("=");
  callArgs[key] = rest.join("=");
}

process.env.DB_PATH ??= join(mkdtempSync(join(tmpdir(), "probe-graft-")), "probe.db");

const { migrate } = await import(join(serverDir, "src/db.ts"));
const { runMigrations } = await import(join(serverDir, "src/migrations.ts"));
const { buildRoleToolCatalog } = await import(join(serverDir, "src/runtime/roleToolCatalog.ts"));
const { connectRoleMcp } = await import(join(serverDir, "src/runtime/graftMcp.ts"));

migrate();
runMigrations();

const mcp = await connectRoleMcp(role, process.cwd());
const catalog = buildRoleToolCatalog(
  { role, mode: "work", runId: "probe", chatId: "probe", messageId: "probe", executionMode: "chat" } as any,
  mcp.tools as any[],
);
let active: string[] = [...catalog.activeNames];
catalog.attachSession({
  getActiveToolNames: () => active,
  setActiveToolsByName: (names: string[]) => { active = [...new Set(names)]; },
});

const parse = (result: any) => JSON.parse(result?.content?.[0]?.text ?? "{}");
const byName = parse(await catalog.loader.tool.execute("1", { names: [toolName] }));
const query = arg("query", "найти операцию подключения инструментов по требованию")!;
const byQuery = parse(await catalog.loader.tool.execute("2", { query }));

const tool = (catalog.customTools as any[]).find((item) => item.name === toolName);
if (!tool) throw new Error(`операции ${toolName} нет в наборе роли ${role}`);

let text = "";
let error = "";
try {
  const result: any = await tool.execute("call-1", callArgs);
  text = (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
} catch (cause: any) {
  error = cause instanceof Error ? cause.message : String(cause);
}
await mcp.close().catch(() => {});

console.log(JSON.stringify({
  роль: role,
  мост: "graft mcp (граф кода, настоящий процесс)",
  операция: toolName,
  аргументы: callArgs,
  была_активна_до_подключения: catalog.activeNames.includes(toolName),
  подключено_по_имени: byName.activated ?? byName,
  подключено_по_смыслу: byQuery.activated ?? byQuery,
  активна_после: active.includes(toolName),
  исполнение_успешно: !error && text.length > 0 && !/not found|не найден|not available/i.test(text),
  ошибка: error || null,
  символов_в_ответе: text.length,
  начало_ответа: text.slice(0, 400) || null,
}, null, 1));
process.exit(0);
