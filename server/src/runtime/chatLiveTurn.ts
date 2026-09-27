// Живой ход роли в чате (владелец 27.09.2026): пока роль отвечает, окно
// чата показывает то же, что окно сессии Claude Code, — текст ответа
// растёт по словам, над ним лента шагов (что читает, что выполняет, что
// ищет). После ответа шаги остаются в истории свёрнутой строкой.
//
// Источник — события рантайма роли внутри startChatRun (onEvent). Здесь
// они сводятся в снимок хода и рассылаются участникам чата событием
// `chats:live` (не чаще раза в LIVE_BROADCAST_MS — токенов в секунду
// много, а глазу хватает). Тот же снимок отдаёт GET /api/chats/:id/live —
// для того, кто открыл чат посреди хода или переподключился.
//
// Снимок хранится только в памяти процесса: после рестарта сервера
// незаконченный ход и так оборван, восстанавливать нечего.
import { broadcastToUsers } from "../ws.js";

export const LIVE_BROADCAST_MS = 150;
const DETAIL_MAX = 140;
const TEXT_MAX = 20_000;
const ITEMS_MAX = 200;

export type LiveItem =
  | { kind: "text"; text: string }
  | {
      kind: "step";
      id: string;
      tool: string;
      detail: string | null;
      status: "running" | "done" | "error";
      started_at: string;
      ended_at?: string;
    };

export interface LiveTurnSnapshot {
  chat_id: string;
  user_id: string;
  name: string;
  started_at: string;
  items: LiveItem[];
}

/** То, что ложится в chat_messages.steps вместе с ответом. */
export interface SavedSteps {
  duration_ms: number;
  items: LiveItem[];
}

const liveTurns = new Map<string, LiveTurn>();
const keyOf = (chatId: string, userId: string) => `${chatId}\u0000${userId}`;

/** Идущие сейчас ходы в чате — для GET /api/chats/:id/live. */
export function liveTurnsOfChat(chatId: string): LiveTurnSnapshot[] {
  return [...liveTurns.values()]
    .filter((t) => t.chatId === chatId)
    .map((t) => t.snapshot());
}

/** Тестовая утилита. */
export function _resetLiveTurnsForTests(): void {
  for (const t of liveTurns.values()) t.dispose();
  liveTurns.clear();
}

// ── Подпись шага ────────────────────────────────────────────────────────

// Порядок важен: заголовок авторизации — вместе со схемой («Bearer …»),
// иначе затиралось бы слово «Bearer», а сам ключ оставался.
const SECRET_PATTERNS: RegExp[] = [
  /(authorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)[^\s"'&]+/gi,
  /((?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g,
  /\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,
];

/** Затереть то, что похоже на ключ, — подпись шага видна в чате. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === "string" && prefix.length < 40 && /[:=\s]$/.test(prefix)
        ? `${prefix}•••`
        : "•••",
    );
  }
  // Длинные «сплошные» строки (hex/base64 от 40 символов) — почти наверняка
  // ключ или хэш, человеку в подписи они ничего не говорят.
  return out.replace(/[A-Za-z0-9+/=_-]{40,}/g, "•••");
}

function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
}

/** Короткая подпись шага из аргументов инструмента: путь, команда,
 *  шаблон поиска. Сервер интерпретирует только аргументы — подпись
 *  действия («Читает», «Выполняет») выбирает клиент по имени инструмента. */
export function stepDetail(tool: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : null);
  let raw: string | null = null;
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "ls":
      raw = str("path") ?? str("file_path");
      if (raw) raw = shortPath(raw);
      break;
    case "bash":
      raw = str("command");
      break;
    case "grep":
    case "find":
    case "glob": {
      const pattern = str("pattern") ?? str("query");
      const where = str("path");
      raw = pattern
        ? where
          ? `${pattern} — ${shortPath(where)}`
          : pattern
        : where && shortPath(where);
      break;
    }
    case "mcp": {
      // Инструменты трекера роль зовёт через общий `mcp`: настоящее
      // действие — в args.tool («taskflow_taskflow_status»), его аргументы —
      // в args.args. Живой ход 27.09.2026 показал голое «Действие» без
      // подписи — называем по-человечески.
      const inner = str("tool");
      if (!inner) break;
      const what = mcpToolTitle(inner);
      const nested = a.args && typeof a.args === "object" ? stepDetail("", a.args) : null;
      raw = nested ? `${what} — ${nested}` : what;
      break;
    }
    default: {
      // Инструменты трекера и прочие: первая осмысленная строка из
      // аргументов (название задачи, запрос поиска и т.п.).
      for (const k of ["title", "query", "text", "url", "name", "id"]) {
        if (str(k)) {
          raw = str(k);
          break;
        }
      }
    }
  }
  return raw ? clip(redactSecrets(raw)) : null;
}

const MCP_TOOL_TITLES: Record<string, string> = {
  my_tasks: "мои задачи",
  task: "карточка задачи",
  status: "сводка доски",
  agents: "кто на связи",
  projects: "проекты",
  project_tasks: "задачи проекта",
  create_task: "новая задача",
  create_project: "новый проект",
  comment: "комментарий к задаче",
  state: "состояние задачи",
  subtask_add: "новый шаг задачи",
  subtask_done: "шаг задачи закрыт",
  subtask_work: "шаг задачи в работе",
  rules: "правила трекера",
  runtime: "рантайм",
  docs: "документы",
  doc_read: "чтение документа",
  doc_write: "запись документа",
  kb_search: "поиск в базе знаний",
  chat_read: "чтение чата",
  chat_send: "сообщение в чат",
  suggest_subtasks: "разбивка на шаги",
  structure_dictation: "разбор надиктовки",
  my_stats: "статистика",
};

/** «taskflow_taskflow_status» → «сводка доски»; незнакомое — словами без
 *  служебных приставок сервера. */
export function mcpToolTitle(name: string): string {
  const bare = name.replace(/^(?:taskflow_)+/, "");
  return MCP_TOOL_TITLES[bare] ?? bare.replace(/_/g, " ");
}

/** Строка быстрых ответов Секретаря («БЫСТРО: …») — служебная, её
 *  разбирает secretaryReply.ts. В живом тексте её не показываем, в том
 *  числе недописанную («БЫС…»), чтобы она не мигала в пузыре. */
export function stripQuickRepliesLine(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !/^\s*БЫСТРО:/i.test(line));
  const last = kept[kept.length - 1];
  if (last !== undefined) {
    const t = last.trim().toUpperCase();
    if (t.length > 0 && "БЫСТРО:".startsWith(t)) kept.pop();
  }
  return kept.join("\n");
}

// ── Сам ход ─────────────────────────────────────────────────────────────

export class LiveTurn {
  readonly chatId: string;
  readonly userId: string;
  readonly name: string;
  private readonly audience: () => string[];
  private readonly startedAt = new Date();
  private items: LiveItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Ход-двойник: для этой пары уже идёт живой ход, этот ничего не
   *  рассылает и не трогает чужой снимок. */
  private readonly detached: boolean;

  constructor(args: {
    chatId: string;
    userId: string;
    name: string;
    audience: () => string[];
    detached?: boolean;
  }) {
    this.chatId = args.chatId;
    this.userId = args.userId;
    this.name = args.name;
    this.audience = args.audience;
    this.detached = args.detached ?? false;
    if (this.detached) this.closed = true;
  }

  /** Событие рантайма роли. Всё незнакомое молча пропускаем. */
  readonly onEvent = (event: unknown): void => {
    if (this.closed || !event || typeof event !== "object") return;
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      isError?: boolean;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      this.appendText(e.assistantMessageEvent.delta ?? "");
    } else if (e.type === "tool_execution_start" && e.toolName) {
      if (this.items.length >= ITEMS_MAX) return;
      this.items.push({
        kind: "step",
        id: e.toolCallId || `step-${this.items.length}`,
        tool: e.toolName,
        detail: stepDetail(e.toolName, e.args),
        status: "running",
        started_at: new Date().toISOString(),
      });
      this.schedule(true);
    } else if (e.type === "tool_execution_end" && e.toolCallId) {
      const step = this.items.find(
        (it) => it.kind === "step" && it.id === e.toolCallId,
      );
      if (step && step.kind === "step") {
        step.status = e.isError ? "error" : "done";
        step.ended_at = new Date().toISOString();
        this.schedule(true);
      }
    }
  };

  private appendText(delta: string): void {
    if (!delta) return;
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "text") {
      if (last.text.length < TEXT_MAX) last.text += delta;
    } else if (this.items.length < ITEMS_MAX) {
      this.items.push({ kind: "text", text: delta });
    }
    this.schedule(false);
  }

  snapshot(): LiveTurnSnapshot {
    const items: LiveItem[] = [];
    for (const it of this.items) {
      if (it.kind === "text") {
        const text = stripQuickRepliesLine(it.text);
        if (text.trim()) items.push({ kind: "text", text });
      } else {
        items.push({ ...it });
      }
    }
    return {
      chat_id: this.chatId,
      user_id: this.userId,
      name: this.name,
      started_at: this.startedAt.toISOString(),
      items,
    };
  }

  /** Шаг — сразу (их мало, и важно увидеть начало), текст — пачкой. */
  private schedule(immediate: boolean): void {
    if (immediate) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), LIVE_BROADCAST_MS);
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    broadcastToUsers(this.audience(), {
      type: "chats:live",
      chat_id: this.chatId,
      user_id: this.userId,
      turn: this.snapshot(),
    });
  }

  /** Ход закончен (успешно или нет): убрать живой снимок у всех и отдать
   *  то, что сохранится в истории. Последний текстовый кусок — это сам
   *  ответ, он ляжет пузырём, поэтому в шаги не идёт. Шагов не было —
   *  null: обычный короткий ответ без свёрнутой строки. */
  finish(): SavedSteps | null {
    if (this.closed) return null;
    this.closed = true;
    this.dispose();
    liveTurns.delete(keyOf(this.chatId, this.userId));
    broadcastToUsers(this.audience(), {
      type: "chats:live",
      chat_id: this.chatId,
      user_id: this.userId,
      turn: null,
    });
    const items = this.snapshot().items;
    if (items.length && items[items.length - 1].kind === "text") items.pop();
    const now = new Date().toISOString();
    for (const it of items) {
      if (it.kind === "step" && it.status === "running") {
        it.status = "error";
        it.ended_at = now;
      }
    }
    if (!items.some((it) => it.kind === "step")) return null;
    return { duration_ms: Date.now() - this.startedAt.getTime(), items };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Начать живой ход для пары (чат, роль). */
export function startLiveTurn(args: {
  chatId: string;
  userId: string;
  name: string;
  audience: () => string[];
}): LiveTurn {
  const key = keyOf(args.chatId, args.userId);
  // Ход этой роли в чате уже идёт (второе сообщение Секретарю подряд):
  // startChatRun всё равно откажет по локу, а живую ленту первого хода
  // трогать нельзя — отдаём немой двойник.
  if (liveTurns.has(key)) return new LiveTurn({ ...args, detached: true });
  const turn = new LiveTurn(args);
  liveTurns.set(key, turn);
  return turn;
}

/** Человеческий текст о сорванном ходе — ложится в чат вместо тишины. */
export function chatRunFailureText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  // Ход этой роли уже идёт и ответит сам — писать нечего.
  if (code === "CHAT_RUN_BUSY") return "";
  if (code === "CHAT_RUN_IDLE") {
    const min = Math.round(((error as { limitMs?: number }).limitMs ?? 0) / 60_000);
    return `Остановил ход: ${min} мин не было никаких действий. Напишите, если продолжить.`;
  }
  if (code === "CHAT_RUN_CEILING") {
    const min = Math.round(((error as { limitMs?: number }).limitMs ?? 0) / 60_000);
    return `Остановил ход: работа шла дольше ${min} мин. Напишите, если продолжить.`;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const firstLine = message.split("\n")[0].replace(/\s*Stderr:.*$/, "").trim();
  return `Не смог ответить: ${clip(redactSecrets(firstLine || "неизвестная ошибка"))}`;
}
