// Пояснения к правилам ролей простым русским для экрана «Реестр правил».
// Для каждого правила, которое доходит до ролей и не имеет пояснения к текущему тексту (sha256),
// по одному запросу просит локальную Qwen на .110 (Ollama :11434). Платные API не используются.
// Запуск из server/: DB_PATH=<путь к taskflow.db> npx tsx scripts/explain-role-rules.ts [--limit N]
import db from "../src/db.js";
import { loadRoleRules, loadRuleOverrides, ruleActive, withOverride } from "../src/lib/roleRules.js";
import { ruleTextHash } from "../src/routes/roleRules.js";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.EXPLAIN_MODEL ?? "qwen3.8-27b-q4k_m:latest";
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const PROMPT = [
  "Ниже правило из инструкции ИИ-роли в трекере задач TaskFlow.",
  "Объясни его владельцу простым русским языком в 1–3 предложениях, без жаргона и без markdown.",
  "Начни ровно со слов «Что роль должна делать:». Ничего не добавляй от себя сверх смысла правила.",
].join("\n");

async function ask(text: string): Promise<string> {
  const res = await fetch(OLLAMA + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: false, think: false, keep_alive: "5m",
      options: { num_ctx: 8192, num_predict: 400, temperature: 0.2 },
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: "Правило:\n" + text }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return (body.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function main() {
  const overrides = loadRuleOverrides();
  const have = new Map((db.prepare("SELECT id, text_hash FROM role_rule_explanations").all() as Array<{ id: string; text_hash: string }>).map((r) => [r.id, r.text_hash]));
  const todo = loadRoleRules().filter((r) => r.kind !== "compose" && ruleActive(withOverride(r, overrides.get(r.id)), overrides.get(r.id)) && have.get(r.id) !== ruleTextHash(r.text));
  console.log(`[explain] к пояснению: ${todo.length}, модель ${MODEL}`);
  const save = db.prepare(`INSERT INTO role_rule_explanations(id, text_hash, explanation, created_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET text_hash=excluded.text_hash, explanation=excluded.explanation, created_at=excluded.created_at`);
  let done = 0, failed = 0;
  for (const rule of todo.slice(0, limit)) {
    const t0 = Date.now();
    try {
      const out = await ask(rule.text);
      if (!out.startsWith("Что роль должна делать:")) throw new Error("ответ не по форме: " + out.slice(0, 120));
      save.run(rule.id, ruleTextHash(rule.text), out, new Date().toISOString());
      done++;
      console.log(`[explain] ${rule.id} ok ${Date.now() - t0}мс (${done}/${todo.length})`);
    } catch (e) {
      failed++;
      console.log(`[explain] ${rule.id} ошибка: ${(e as Error).message}`);
    }
  }
  // Освободить видеокарту для ролей.
  await fetch(OLLAMA + "/api/generate", { method: "POST", body: JSON.stringify({ model: MODEL, keep_alive: 0 }) }).catch(() => {});
  console.log(`[explain] готово: ${done}, ошибок ${failed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
