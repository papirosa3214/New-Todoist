// Сторож Ollama: проверяет, что локальная модель на сервере отвечает.
// Проверка настоящая — один запрос эмбеддинга тем же путём, каким ходит
// прибор (embeddingClient), а не «процесс жив». Пока всё хорошо — молчит;
// сломалось или забилась очередь — задача в «Серверные уведомления», не
// чаще одной в сутки.
//
// Зачем он нужен (владелец 12.10.2026). Ollama — неотъемлемая часть
// контура: от неё зависят эмбеддинги (подбор ролей, фанаут плана,
// смысловой поиск по заметкам) и `local_model`. Когда она отвечает
// «503 server busy, maximum pending requests exceeded», приборы молча
// начинают отдавать 502 — и это выглядит как «сервер сломался», хотя
// сервер жив. Без сторожа владелец узнаёт об этом по пересказу агента
// в чате, а не из «Серверных уведомлений», где такие вещи и ждут.
//
// Отличие от проверки «жив ли процесс»: если Ollama перебита очередью,
// порт слушается и /api/tags отвечает — поэтому проба идёт именно за
// эмбеддингом, тем самым запросом, который реально нужен прибору.

import db from "../db.js";
import { serverNotificationsProjectId } from "./serverNotificationsProject.js";
import {
  OLLAMA_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddingClient.js";

const INTERVAL_MS = 30 * 60 * 1000; // как требует контракт сторожей
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
const PRIORITY = 2;

let pollHandle: NodeJS.Timeout | null = null;
let lastRaisedAt = 0;

interface CheckResult {
  ok: boolean;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Одна проба: короткий запрос эмбеддинга. Различаем «не отвечает» и
 * «перебит очередью» — чинить их по-разному, и владельцу это нужно видеть
 * прямо в заголовке карточки, а не догадываться.
 */
export async function checkOllamaHealth(): Promise<CheckResult> {
  const url = `${OLLAMA_BASE_URL}/api/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_EMBEDDING_MODEL, prompt: "проверка" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const busy = /busy|pending requests/i.test(text);
      return {
        ok: false,
        reason: busy
          ? `Ollama перебита: ответила ${res.status} «${text.slice(0, 120)}» — очередь запросов исчерпана`
          : `Ollama ответила ${res.status}: ${text.slice(0, 120)}`,
        details: { status: res.status, base_url: OLLAMA_BASE_URL, model: DEFAULT_EMBEDDING_MODEL },
      };
    }
    const data = (await res.json()) as { embedding?: unknown };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      return {
        ok: false,
        reason: "Ollama ответила без массива эмбеддинга — ответ непригоден",
        details: { base_url: OLLAMA_BASE_URL, model: DEFAULT_EMBEDDING_MODEL },
      };
    }
    return { ok: true, reason: "" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return {
      ok: false,
      reason: e?.name === "AbortError"
        ? `Ollama не ответила за ${PROBE_TIMEOUT_MS} мс`
        : `Ollama недоступна: ${msg.slice(0, 160)}`,
      details: { base_url: OLLAMA_BASE_URL, model: DEFAULT_EMBEDDING_MODEL },
    };
  } finally {
    clearTimeout(timer);
  }
}

function raise(reason: string, details?: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastRaisedAt < DAY_MS) return;
  lastRaisedAt = now;
  const id = `ollama-health-${Date.now().toString(36)}`;
  const title = `Локальная модель (Ollama) недоступна: ${reason}`;
  const description = [
    "## Что случилось",
    "Сторож локальной модели не смог получить эмбеддинг от Ollama.",
    "",
    "## Причина",
    reason,
    details ? `\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`\n` : "",
    "",
    "## Что сломано",
    "От локальной модели зависят приборы: подбор роли для подзадач и плана,",
    "смысловой поиск по заметкам и базе знаний, отчёты. Они начинают",
    "отдавать 502 — при живом сервере, поэтому по симптомам похоже на",
    "падение TaskFlow, хотя сломалась только Ollama.",
    "",
    "## Что делать",
    "- `curl -X POST http://127.0.0.1:11434/api/embeddings -H 'Content-Type: application/json' -d '{\"model\":\"bge-m3-embed:latest\",\"prompt\":\"test\"}'` — должен вернуть массив embedding.",
    "- Если «server busy, maximum pending requests exceeded» — очередь исчерпана: найти, кто держит её открытым запросом, и снять его.",
    "- Проверить, что модель `bge-m3-embed:latest` вообще выкачена: `ollama list`.",
  ].join("\n");
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, priority, creator_id, status, agent_state, project_id
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?)`,
    ).run(id, title, description, PRIORITY, "u1", serverNotificationsProjectId("u1"));
  });
  txn();
}

export function startOllamaHealthWatcher(): void {
  if (process.env.OLLAMA_HEALTH_WATCHER_DISABLED === "1") return;
  if (pollHandle) return;
  const tick = async () => {
    try {
      const result = await checkOllamaHealth();
      if (!result.ok) raise(result.reason, result.details);
    } catch (e: any) {
      console.warn("[ollama-watch] проба не отработала:", e);
    }
  };
  void tick();
  pollHandle = setInterval(() => void tick(), INTERVAL_MS);
  pollHandle.unref?.();
}