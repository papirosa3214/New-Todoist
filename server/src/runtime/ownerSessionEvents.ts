import crypto from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { recordModelUsage } from "../lib/modelUsage.js";
import { sourcedChatBlocks } from "../sessions/sessionChatBlocks.js";
import { extractQuickReplies } from "../sessions/sessionQuickReplies.js";
import {
  addAnswerToTurn,
  finishTurn,
  ownerSessionAnswerCall,
  startTurn,
  type OwnerSessionFinishedTurn,
  type OwnerSessionTurnDraft,
} from "./ownerSessionTurnUsage.js";

export interface OwnerSessionEventEnvelope {
  cursor: string;
  sessionId: string;
  entryId?: string;
  type: string;
  timestamp: string;
  payload: Record<string, any>;
}

export interface OwnerSessionEventMeta {
  cursor: string;
  timestamp: string;
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): any {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => jsonSafe(item, seen)).filter(item => item !== undefined);
  }
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    const safe = jsonSafe(item, seen);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function payloadWithoutType(event: Record<string, any>): Record<string, any> {
  const { type: _type, ...payload } = event;
  return jsonSafe(payload);
}

function envelope(
  sessionId: string,
  type: string,
  payload: Record<string, any>,
  meta: OwnerSessionEventMeta,
  entryId?: string,
): OwnerSessionEventEnvelope {
  return {
    cursor: meta.cursor,
    sessionId,
    ...(entryId ? { entryId } : {}),
    type,
    timestamp: meta.timestamp,
    payload: jsonSafe(payload),
  };
}

const PASSTHROUGH_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "thinking_level_changed",
  "session_info_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
]);

/** Весь текст части ответа на этот момент (часть contentIndex сообщения). */
function partText(message: any, index: unknown, kind: "text" | "thinking"): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const part = typeof index === "number" ? parts[index] : undefined;
  const value = kind === "text" ? part?.text : part?.thinking;
  return typeof value === "string" ? value : "";
}

/** Translate one live Pi event without turning it into a second transcript. */
export function normalizePiEvent(
  sessionId: string,
  event: AgentSessionEvent,
  meta: OwnerSessionEventMeta,
): OwnerSessionEventEnvelope {
  const raw = event as unknown as Record<string, any>;
  switch (raw.type) {
    case "message_update": {
      const stream = raw.assistantMessageEvent as Record<string, any>;
      if (stream?.type === "text_delta") {
        // Тонкий клиент (владелец 13.11.2026): к куску — весь текст части и
        // готовые блоки, как у живого хода ролей (liveTurnForClient).
        // Строка БЫСТРО: — не текст, а кнопки: в блоки не идёт.
        const full = extractQuickReplies(partText(raw.message, stream.contentIndex, "text")).clean;
        return envelope(sessionId, "assistant_text_delta", {
          delta: stream.delta,
          contentIndex: stream.contentIndex,
          ...(full ? { text: full, blocks: sourcedChatBlocks(full, true) } : {}),
        }, meta);
      }
      if (stream?.type === "thinking_delta") {
        const full = partText(raw.message, stream.contentIndex, "thinking");
        return envelope(sessionId, "assistant_thinking_delta", {
          delta: stream.delta,
          contentIndex: stream.contentIndex,
          ...(full ? { text: full, blocks: sourcedChatBlocks(full, true) } : {}),
        }, meta);
      }
      return envelope(sessionId, "assistant_stream_event", {
        event: stream,
      }, meta);
    }
    case "message_end":
      return envelope(sessionId, "message_end", { message: raw.message }, meta);
    case "tool_execution_start":
      return envelope(sessionId, "tool_start", {
        toolCallId: raw.toolCallId,
        parentToolCallId: raw.parentToolCallId,
        toolName: raw.toolName,
        args: raw.args,
      }, meta);
    case "tool_execution_update":
      return envelope(sessionId, "tool_update", {
        toolCallId: raw.toolCallId,
        parentToolCallId: raw.parentToolCallId,
        toolName: raw.toolName,
        args: raw.args,
        partialResult: raw.partialResult,
      }, meta);
    case "tool_execution_end":
      return envelope(sessionId, "tool_end", {
        toolCallId: raw.toolCallId,
        parentToolCallId: raw.parentToolCallId,
        toolName: raw.toolName,
        result: raw.result,
        isError: raw.isError,
        durationMs: raw.durationMs,
      }, meta);
    case "queue_update":
      return envelope(sessionId, "queue_update", {
        steering: raw.steering,
        followUp: raw.followUp,
      }, meta);
    case "auto_retry_start":
      return envelope(sessionId, "retry_start", payloadWithoutType(raw), meta);
    case "auto_retry_end":
      return envelope(sessionId, "retry_end", payloadWithoutType(raw), meta);
    case "compaction_start":
      return envelope(sessionId, "compaction_start", payloadWithoutType(raw), meta);
    case "compaction_end":
      return envelope(sessionId, "compaction_end", payloadWithoutType(raw), meta);
    case "agent_settled":
      return envelope(sessionId, "agent_settled", { aborted: raw.aborted }, meta);
    case "entry_appended":
      return envelope(sessionId, "entry_appended", { entry: raw.entry }, meta, raw.entry?.id);
    default:
      if (PASSTHROUGH_EVENTS.has(raw.type)) {
        return envelope(sessionId, raw.type, payloadWithoutType(raw), meta);
      }
      return envelope(sessionId, "pi_unknown", {
        piType: typeof raw.type === "string" ? raw.type : "unknown",
        event: raw,
      }, meta);
  }
}

export interface OwnerSessionEventBufferOptions {
  capacity?: number;
  clock?: () => Date;
  epoch?: string;
}

export interface OwnerSessionReconnectSlice {
  resetRequired: boolean;
  events: OwnerSessionEventEnvelope[];
}

/**
 * Bounded reconnect aid for live transport only. A missing cursor tells the
 * caller to fetch a fresh SessionManager snapshot before applying retained
 * events; no event here is treated as durable transcript state.
 */
export class OwnerSessionEventBuffer {
  private readonly capacity: number;
  private readonly clock: () => Date;
  private readonly epoch: string;
  private sequence = 0;
  private retained: OwnerSessionEventEnvelope[] = [];
  /** Накопитель расхода живого хода по сессии (13.11.2026). */
  private readonly liveTurns = new Map<string, OwnerSessionTurnDraft>();

  constructor(options: OwnerSessionEventBufferOptions = {}) {
    const capacity = options.capacity ?? 512;
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Event buffer capacity must be a positive integer");
    this.capacity = capacity;
    this.clock = options.clock ?? (() => new Date());
    this.epoch = options.epoch ?? crypto.randomUUID();
  }

  push(sessionId: string, event: AgentSessionEvent): OwnerSessionEventEnvelope {
    const cursor = `${this.epoch}:${++this.sequence}`;
    this.observeTurn(sessionId, event);
    const normalized = normalizePiEvent(sessionId, event, {
      cursor,
      timestamp: this.clock().toISOString(),
    });
    let envelopeOut = normalized;
    if (normalized.type === "agent_settled") {
      const finished = this.settleTurn(sessionId);
      if (finished) {
        envelopeOut = {
          ...normalized,
          payload: { ...normalized.payload, turn_usage: finished.turn_usage },
        };
        this.recordTurnUsage(sessionId, finished);
      }
    }
    this.retained.push(envelopeOut);
    if (this.retained.length > this.capacity) {
      this.retained = this.retained.slice(this.retained.length - this.capacity);
    }
    return envelopeOut;
  }

  /** Ход копится по живым событиям: agent_start начинает заново, каждый
   *  ответ ассистента прибавляется к текущему ходу. */
  private observeTurn(sessionId: string, event: AgentSessionEvent): void {
    const raw = event as unknown as Record<string, any>;
    if (raw.type === "agent_start") {
      this.liveTurns.delete(sessionId);
      return;
    }
    if (raw.type !== "message_end") return;
    const message = raw.message;
    if (message?.role === "user") {
      const stamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : this.clock().getTime();
      this.liveTurns.set(sessionId, startTurn(new Date(stamp).toISOString(), stamp));
      return;
    }
    const call = ownerSessionAnswerCall(message);
    if (!call) return;
    const draft = this.liveTurns.get(sessionId)
      ?? startTurn(this.clock().toISOString(), this.clock().getTime());
    this.liveTurns.set(sessionId, addAnswerToTurn(draft, call));
  }

  private settleTurn(sessionId: string): OwnerSessionFinishedTurn | null {
    const draft = this.liveTurns.get(sessionId);
    this.liveTurns.delete(sessionId);
    return draft ? finishTurn(draft) : null;
  }

  /** Итог хода сессии владельца в model_usage — одна строка на ход, как у
   *  чатов (chatLiveTurn.ts). Повтор того же события отсекается отпечатком
   *  записи в recordModelUsage. */
  private recordTurnUsage(sessionId: string, finished: OwnerSessionFinishedTurn): void {
    const usage = finished.turn_usage;
    if (finished.occurred_at_ms === null || usage.calls < 1) return;
    try {
      recordModelUsage({
        role: "assistant",
        timestamp: finished.occurred_at_ms,
        provider: finished.provider ?? "unknown",
        model: usage.model ?? "unknown",
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cache_read,
          cacheWrite: usage.cache_write,
          ...(usage.cost_usd === null ? {} : { cost: { total: usage.cost_usd } }),
        },
        content: `owner-session ${sessionId} ${usage.started_at ?? ""}`,
      }, "owner_session");
    } catch {
      /* счётчик расхода не должен ронять живые события */
    }
  }

  eventsAfter(cursor?: string, sessionId?: string): OwnerSessionReconnectSlice {
    const belongs = (event: OwnerSessionEventEnvelope) => !sessionId || event.sessionId === sessionId;
    if (!cursor) return { resetRequired: false, events: this.retained.filter(belongs) };
    const index = this.retained.findIndex(event => event.cursor === cursor);
    if (index < 0) {
      return { resetRequired: true, events: this.retained.filter(belongs) };
    }
    return {
      resetRequired: false,
      events: this.retained.slice(index + 1).filter(belongs),
    };
  }
}
