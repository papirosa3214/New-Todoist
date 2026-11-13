import type { TurnUsage } from "./chatLiveTurn.js";

/** Один ответ модели в ветке сессии владельца: то, что лежит в записи
 *  сообщения (`message.usage`, `message.durationMs`, `message.timestamp`). */
export interface OwnerSessionAnswerCall {
  usage: TurnUsage;
  provider: string | null;
  timestamp: number | null;
  durationMs: number | null;
}

/** Итог хода сессии владельца — та же форма, что строка расхода под ответом
 *  в чате (`TurnUsage`), плюс длительность хода и время начала хода. */
export interface OwnerSessionTurnUsage extends TurnUsage {
  /** От реплики владельца до конца последнего ответа. */
  duration_ms: number | null;
  /** Время реплики владельца (ISO). */
  started_at: string | null;
}

/** Итог хода вместе с тем, что нужно счётчику расхода, но не нужно клиенту. */
export interface OwnerSessionFinishedTurn {
  turn_usage: OwnerSessionTurnUsage;
  provider: string | null;
  /** Время последнего ответа хода (мс) — по нему пишется строка расхода. */
  occurred_at_ms: number | null;
}

export interface OwnerSessionTurnDraft {
  startedAt: string | null;
  startedAtMs: number | null;
  usage: TurnUsage | null;
  provider: string | null;
  occurredAtMs: number | null;
  lastDurationMs: number | null;
}

export interface OwnerSessionTurn {
  started_at: string | null;
  usage: OwnerSessionTurnUsage | null;
  /** Запись последнего ответа хода: на неё клиенту вешается строка расхода. */
  entry_key: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Разбор записи ответа ассистента. null — запись не про расход. */
export function ownerSessionAnswerCall(message: any): OwnerSessionAnswerCall | null {
  if (!message || message.role !== "assistant" || !message.usage) return null;
  const u = message.usage;
  const input = num(u.input);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const cost = u.cost && typeof u.cost.total === "number" && Number.isFinite(u.cost.total) ? u.cost.total : null;
  const durationMs = ms(message.durationMs);
  return {
    usage: {
      input,
      output: num(u.output),
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost_usd: cost,
      generation_ms: durationMs,
      model: typeof message.model === "string" ? message.model : null,
      context: input + cacheRead + cacheWrite,
      calls: 1,
    },
    provider: typeof message.provider === "string" ? message.provider : null,
    timestamp: ms(message.timestamp),
    durationMs,
  };
}

/** Сложение итогов как в чате (chatLiveTurn.addUsage): суммы по ходу,
 *  context — последнего обращения, model — последнего обращения. */
export function mergeTurnUsage(prev: TurnUsage | null, add: TurnUsage): TurnUsage {
  if (!prev) return { ...add };
  return {
    input: prev.input + add.input,
    output: prev.output + add.output,
    cache_read: prev.cache_read + add.cache_read,
    cache_write: prev.cache_write + add.cache_write,
    cost_usd: prev.cost_usd === null && add.cost_usd === null ? null : (prev.cost_usd ?? 0) + (add.cost_usd ?? 0),
    generation_ms: prev.generation_ms === null && add.generation_ms === null
      ? null
      : (prev.generation_ms ?? 0) + (add.generation_ms ?? 0),
    model: add.model ?? prev.model,
    context: add.context,
    calls: prev.calls + add.calls,
  };
}

export function startTurn(startedAt: string | null = null, startedAtMs: number | null = null): OwnerSessionTurnDraft {
  const at = ms(startedAtMs);
  return {
    startedAt,
    startedAtMs: at,
    usage: null,
    provider: null,
    occurredAtMs: null,
    lastDurationMs: null,
  };
}

/** Прибавить один ответ к ходу. Возвращает новое состояние, старое не меняется. */
export function addAnswerToTurn(draft: OwnerSessionTurnDraft, call: OwnerSessionAnswerCall): OwnerSessionTurnDraft {
  return {
    ...draft,
    usage: mergeTurnUsage(draft.usage, call.usage),
    provider: call.provider ?? draft.provider,
    occurredAtMs: call.timestamp ?? draft.occurredAtMs,
    lastDurationMs: call.durationMs ?? draft.lastDurationMs,
  };
}

/** Итог хода. null — в ходе не было ни одного ответа с расходом. */
export function finishTurn(draft: OwnerSessionTurnDraft): OwnerSessionFinishedTurn | null {
  const usage = draft.usage;
  if (!usage) return null;
  const last = draft.occurredAtMs;
  const duration = last === null || draft.startedAtMs === null
    ? null
    : last + (draft.lastDurationMs ?? 0) - draft.startedAtMs;
  return {
    turn_usage: {
      ...usage,
      duration_ms: duration,
      started_at: draft.startedAt,
    },
    provider: draft.provider,
    occurred_at_ms: last,
  };
}

/** Ключ записи ветки: id, а если его нет — номер по порядку. */
export function ownerSessionEntryKey(entry: any, index: number): string {
  return typeof entry?.id === "string" && entry.id ? entry.id : `#${index}`;
}

function userTurnStart(entry: any): { iso: string | null; ms: number | null } {
  const fromMessage = ms(entry?.message?.timestamp);
  const fromEntry = typeof entry?.timestamp === "string" ? ms(Date.parse(entry.timestamp)) : null;
  const at = fromMessage ?? fromEntry;
  return { iso: at === null ? null : new Date(at).toISOString(), ms: at };
}

/** Ветка сессии, порезанная на ходы: ход начинается с реплики владельца. */
export function ownerSessionTurns(entries: readonly any[] = []): OwnerSessionTurn[] {
  const turns: OwnerSessionTurn[] = [];
  let draft = startTurn();
  let lastKey: string | null = null;

  const close = () => {
    const finished = finishTurn(draft);
    if (finished && lastKey) {
      turns.push({ started_at: finished.turn_usage.started_at, usage: finished.turn_usage, entry_key: lastKey });
    }
  };

  entries.forEach((entry, index) => {
    if (entry?.type === "message" && entry.message?.role === "user") {
      close();
      const start = userTurnStart(entry);
      draft = startTurn(start.iso, start.ms);
      lastKey = null;
      return;
    }
    if (entry?.type !== "message") return;
    const call = ownerSessionAnswerCall(entry.message);
    if (!call) return;
    draft = addAnswerToTurn(draft, call);
    lastKey = ownerSessionEntryKey(entry, index);
  });
  close();
  return turns;
}

/** Итог хода по ключу записи последнего ответа — для подписи ответа в снимке. */
export function ownerSessionTurnUsageByEntry(entries: readonly any[] = []): Map<string, OwnerSessionTurnUsage> {
  const result = new Map<string, OwnerSessionTurnUsage>();
  for (const turn of ownerSessionTurns(entries)) {
    if (turn.entry_key && turn.usage) result.set(turn.entry_key, turn.usage);
  }
  return result;
}
