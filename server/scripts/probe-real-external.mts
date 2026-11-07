/**
 * Живая проверка: операция внешнего сервиса, подключённая через taskflow_tools,
 * действительно исполняется на настоящем мосте (Things 3 через шлюз хоста,
 * инфрапанель), а не отвечает «Tool not found». Это не заглушка: адаптер —
 * тот же, что поднимает живой ход роли.
 *
 *   npx tsx scripts/probe-real-external.mts --role secretary --tool things_today
 *   npx tsx scripts/probe-real-external.mts --role secretary --tool things_today --query "дела на сегодня"
 *
 * Печатает один JSON: чем подключилось (по имени, по смыслу), что вернула
 * операция и признак «исполнение не пустое». База временная, операция только
 * чтение — побочных записей в Things и в трекере нет.
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
const serverDir = resolve(arg("server-dir", join(dirname(fileURLToPath(import.meta.url)), "..")));
const role = arg("role", "secretary")!;
const toolName = arg("tool", "things_today")!;
const query = arg("query", "посмотреть сегодняшние дела")!;

process.env.DB_PATH ??= join(mkdtempSync(join(tmpdir(), "probe-external-")), "probe.db");

const { migrate } = await import(join(serverDir, "src/db.ts"));
const { runMigrations } = await import(join(serverDir, "src/migrations.ts"));
const { buildRoleToolCatalog } = await import(join(serverDir, "src/runtime/roleToolCatalog.ts"));
const { secretaryThings3Tools } = await import(join(serverDir, "src/runtime/secretaryThings3Tools.ts"));

migrate();
runMigrations();

const adapters = secretaryThings3Tools({ role, chatId: "probe", messageId: "probe" }) as any[];
const catalog = buildRoleToolCatalog(
  { role, mode: "work", runId: "probe", chatId: "probe", messageId: "probe", executionMode: "chat" } as any,
  adapters,
);
let active: string[] = [...catalog.activeNames];
catalog.attachSession({
  getActiveToolNames: () => active,
  setActiveToolsByName: (names: string[]) => { active = [...new Set(names)]; },
});

const parse = (result: any) => JSON.parse(result?.content?.[0]?.text ?? "{}");
const byName = parse(await catalog.loader.tool.execute("1", { names: [toolName] }));
const byQuery = parse(await catalog.loader.tool.execute("2", { query }));

const tool = (catalog.customTools as any[]).find((item) => item.name === toolName);
if (!tool) throw new Error(`операции ${toolName} нет в наборе роли ${role}`);

let executed: any = null;
let error = "";
try {
  executed = await tool.execute("call-1", {});
} catch (cause: any) {
  error = cause instanceof Error ? cause.message : String(cause);
}
const text = (executed?.content ?? []).map((part: any) => part.text ?? "").join("\n").slice(0, 600);

console.log(JSON.stringify({
  роль: role,
  адаптеров: adapters.length,
  операция: toolName,
  была_активна_до_подключения: catalog.activeNames.includes(toolName),
  подключено_по_имени: byName.activated ?? byName,
  подключено_по_смыслу: byQuery.activated ?? byQuery,
  активна_после: active.includes(toolName),
  исполнение_успешно: !error && text.length > 0 && !/not found|не найден|not available/i.test(text),
  ошибка: error || null,
  начало_ответа: text || null,
}, null, 1));
process.exit(0);
