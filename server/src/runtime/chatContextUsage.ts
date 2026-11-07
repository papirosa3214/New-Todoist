// Актуальное окно контекста живой сессии чата (карточка e11eae7a, пункт 4).
//
// Показывает ЗАНЯТОЕ окно настоящей сессии Pi, а не накопленный расход:
// значение берётся из session.getContextUsage() — это оценка контекста по
// последнему ответу модели. Честность источника:
//   • measured        — число токенов известно;
//   • after_compaction— сжатие прошло, нового ответа модели ещё не было;
//   • no_session      — живой сессии нет (ещё не было или сессия сброшена);
//   • unavailable     — рантайм недоступен (внешний агент, Pi не отвечает).
//
// После сброса сессии старые числа не показываются: новая сессия — другой
// sessionId, и замер обнуляется.

import db from "../db.js";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export type ChatContextStatus = "measured" | "no_session" | "after_compaction" | "unavailable";

/**
 * Из чего состоит занятое окно — оценкой тем же правилом, что у Pi
 * (`estimateTokens`, ~4 символа на токен). `other` — расхождение оценки с
 * настоящим итогом `tokens` (служебная разметка модели, кэш и т. п.), чтобы
 * сумма частей совпадала с итогом, а не была придумана.
 */
export type ChatContextBreakdown = {
  system: number;
  tools: number;
  user: number;
  assistant: number;
  toolResults: number;
  other: number;
};

export type ChatContextSnapshot = {
  roleID: string;
  sessionID: string | null;
  model: string | null;
  provider: string | null;
  tokens: number | null;
  contextWindow: number | null;
  measuredAt: string | null;
  status: ChatContextStatus;
  isEstimate: boolean;
  breakdown: ChatContextBreakdown | null;
};

type Entry = {
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  contextWindow: number | null;
  measuredAt: string | null;
  status: ChatContextStatus;
  isEstimate: boolean;
  breakdown: ChatContextBreakdown | null;
  session: any;
};

const entries = new Map<string, Entry>();
const key = (chatId: string, roleId: string) => `${chatId}:${roleId}`;

function emptyEntry(roleId: string): Entry {
  return {
    sessionId: null,
    provider: null,
    model: null,
    tokens: null,
    contextWindow: null,
    measuredAt: null,
    status: "no_session",
    isEstimate: false,
    breakdown: null,
    session: null,
  };
}

/** Живая сессия открыта: смена sessionId — это сброс, старые числа не годят. */
export function openChatSession(params: {
  chatId: string;
  roleId: string;
  session: any;
  sessionId: string | null;
  provider: string | null;
  model: string | null;
}): void {
  const id = key(params.chatId, params.roleId);
  const previous = entries.get(id);
  const entry = previous && previous.sessionId === params.sessionId ? previous : emptyEntry(params.roleId);
  entry.sessionId = params.sessionId ?? null;
  entry.provider = params.provider ?? entry.provider;
  entry.model = params.model ?? entry.model;
  entry.session = params.session ?? null;
  entries.set(id, entry);
  measureChatSession(params.chatId, params.roleId);
}

const tokensOfText = (text: string) => Math.ceil(text.length / 4);

/** Разбивка занятого окна по частям; итог — настоящий `total` из SDK. */
export function contextBreakdown(session: any, total: number): ChatContextBreakdown | null {
  try {
    const system = tokensOfText(String(session.systemPrompt ?? ""));
    const active = new Set<string>(session.getActiveToolNames?.() ?? []);
    const tools = (session.getAllTools?.() ?? [])
      .filter((t: any) => active.has(t.name))
      .reduce((n: number, t: any) => n + tokensOfText(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })), 0);
    let user = 0, assistant = 0, toolResults = 0;
    for (const m of session.state?.messages ?? []) {
      const n = estimateTokens(m);
      if (m?.role === "user") user += n;
      else if (m?.role === "assistant") assistant += n;
      else toolResults += n;
    }
    const known = system + tools + user + assistant + toolResults;
    // Оценка не должна превышать настоящий итог: тогда пропорционально ужимаем.
    const scale = known > total && known > 0 ? total / known : 1;
    const part = (n: number) => Math.round(n * scale);
    const out = { system: part(system), tools: part(tools), user: part(user), assistant: part(assistant), toolResults: part(toolResults), other: 0 };
    out.other = Math.max(0, total - (out.system + out.tools + out.user + out.assistant + out.toolResults));
    return out;
  } catch {
    return null;
  }
}

/** Замер по живой сессии. Значения SDK помечены как оценка — это честно. */
export function measureChatSession(chatId: string, roleId: string): void {
  const entry = entries.get(key(chatId, roleId));
  if (!entry || !entry.session) return;
  measureEntry(entry);
  persistListContext(chatId, roleId, entry);
}

/**
 * Список чатов показывает контекст каждой сессии, а `entries` живёт в памяти
 * процесса и теряется при перезапуске: для списка замер лежит в базе. Сбой
 * записи не должен мешать ходу роли.
 */
function persistListContext(chatId: string, roleId: string, entry: Entry | null): void {
  try {
    if (entry?.tokens == null || entry.contextWindow == null) {
      db.prepare("DELETE FROM chat_context_usage WHERE chat_id=? AND role_id=?").run(chatId, roleId);
      return;
    }
    db.prepare(
      `INSERT INTO chat_context_usage(chat_id,role_id,tokens,context_window,measured_at) VALUES(?,?,?,?,datetime('now'))
       ON CONFLICT(chat_id,role_id) DO UPDATE SET tokens=excluded.tokens,context_window=excluded.context_window,measured_at=excluded.measured_at`,
    ).run(chatId, roleId, entry.tokens, entry.contextWindow);
  } catch (error) {
    console.warn("[chat-context] замер для списка не записан:", error instanceof Error ? error.message : error);
  }
}

/** Последний замер контекста сессии для строки в списке чатов. */
export function readChatListContext(chatId: string): { tokens: number; context_window: number; measured_at: string } | null {
  return (
    (db
      .prepare(
        "SELECT tokens,context_window,measured_at FROM chat_context_usage WHERE chat_id=? ORDER BY measured_at DESC, rowid DESC LIMIT 1",
      )
      .get(chatId) as { tokens: number; context_window: number; measured_at: string } | undefined) ?? null
  );
}

function measureEntry(entry: Entry): void {
  let usage: any;
  try {
    usage = entry.session.getContextUsage?.();
  } catch {
    usage = undefined;
  }
  if (!usage) {
    entry.status = "unavailable";
    entry.breakdown = null;
    entry.tokens = null;
    entry.contextWindow = null;
    entry.measuredAt = new Date().toISOString();
    return;
  }
  entry.contextWindow = typeof usage.contextWindow === "number" ? usage.contextWindow : null;
  entry.measuredAt = new Date().toISOString();
  if (typeof usage.tokens !== "number") {
    // SDK отдаёт null после сжатия, пока модель не ответила снова.
    entry.tokens = null;
    entry.status = "after_compaction";
    entry.isEstimate = false;
    entry.breakdown = null;
    return;
  }
  entry.tokens = usage.tokens;
  entry.status = "measured";
  entry.isEstimate = true;
  entry.breakdown = contextBreakdown(entry.session, usage.tokens);
}

/** Ход закончился: сессия закрыта, последний замер остаётся с меткой времени. */
export function closeChatSession(chatId: string, roleId: string): void {
  const entry = entries.get(key(chatId, roleId));
  if (!entry) return;
  measureChatSession(chatId, roleId);
  entry.session = null;
}

/** Сброс сессии (новая ветка, новая сессия) — старые числа не показываем. */
export function resetChatContext(chatId: string, roleId: string): void {
  entries.delete(key(chatId, roleId));
  persistListContext(chatId, roleId, null);
}

/**
 * Сжатие прошло, а нового ответа модели ещё не было: прежнее занятое окно
 * больше не показатель — помечаем состояние явно (D1 карточки e11eae7a).
 */
export function markChatContextCompacted(chatId: string, roleId: string): void {
  const entry = entries.get(key(chatId, roleId));
  if (!entry) return;
  entry.tokens = null;
  entry.breakdown = null;
  entry.status = "after_compaction";
  entry.isEstimate = false;
  entry.measuredAt = new Date().toISOString();
  persistListContext(chatId, roleId, entry);
}

export function readChatContext(chatId: string, roleId: string): ChatContextSnapshot {
  const entry = entries.get(key(chatId, roleId));
  if (!entry) {
    return {
      roleID: roleId,
      sessionID: null,
      model: null,
      provider: null,
      tokens: null,
      contextWindow: null,
      measuredAt: null,
      status: "no_session",
      isEstimate: false,
      breakdown: null,
    };
  }
  if (entry.session) measureChatSession(chatId, roleId);
  return {
    roleID: roleId,
    sessionID: entry.sessionId,
    model: entry.model,
    provider: entry.provider,
    tokens: entry.tokens,
    contextWindow: entry.contextWindow,
    measuredAt: entry.measuredAt,
    status: entry.status,
    isEstimate: entry.isEstimate,
    breakdown: entry.breakdown,
  };
}

/** Только для тестов и сброса состояния между прогонами. */
export function _clearChatContextForTests(): void {
  entries.clear();
}
