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

export type ChatContextStatus = "measured" | "no_session" | "after_compaction" | "unavailable";

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

/** Замер по живой сессии. Значения SDK помечены как оценка — это честно. */
export function measureChatSession(chatId: string, roleId: string): void {
  const id = key(chatId, roleId);
  const entry = entries.get(id);
  if (!entry || !entry.session) return;
  let usage: any;
  try {
    usage = entry.session.getContextUsage?.();
  } catch {
    usage = undefined;
  }
  if (!usage) {
    entry.status = "unavailable";
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
    return;
  }
  entry.tokens = usage.tokens;
  entry.status = "measured";
  entry.isEstimate = true;
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
  };
}

/** Только для тестов и сброса состояния между прогонами. */
export function _clearChatContextForTests(): void {
  entries.clear();
}
