import {coordinationActivity,traceCoordination} from "./chatCoordination.js";
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
//
// Размышления (владелец 30.09.2026) — тоже элемент хода, `kind: "thinking"`,
// с полным текстом: в чате их можно раскрыть окошком, пока роль думает, и
// открыть целиком после хода. `id`/`tool`/`status` у него есть нарочно —
// клиент, который про размышления ещё не знает, разбирает его как шаг и не
// роняет весь снимок.
import { broadcastToUsers } from "../ws.js";
import { unwrapRoleEnvelopeText } from "../lib/roleContractV1.js";

export const LIVE_BROADCAST_MS = 150;
const DETAIL_MAX = 140;
const TEXT_MAX = 20_000;
const ITEMS_MAX = 200;
const IO_MAX = 4000;

function clipIO(text: string): string {
  const safe = redactSecrets(text);
  return safe.length > IO_MAX ? safe.slice(0, IO_MAX) + "…" : safe;
}
function ioArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  try { return clipIO(JSON.stringify(args, null, 2)); } catch { return undefined; }
}
function ioOutput(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
    if (text) {
      try { return clipIO(JSON.stringify(JSON.parse(text), null, 2)); } catch { return clipIO(text); }
    }
  }
  if (typeof result === "string") return clipIO(result);
  try { return clipIO(JSON.stringify(result, null, 2)); } catch { return undefined; }
}

export type LiveItem =
  | { kind: "text"; text: string }
  | {
      kind: "step";
      id: string;
      tool: string;
      detail: string | null;
      /** Точные аргументы вызова и ответ инструмента — владелец разбирает
       *  сбой по шагу роли сам (19.10.2026). Обрезаются до IO_MAX. */
      args?: string;
      output?: string;
      status: "running" | "done" | "error";
      started_at: string;
      ended_at?: string;
    }
  | {
      kind: "thinking";
      id: string;
      tool: "thinking";
      text: string;
      status: "running" | "done";
      started_at: string;
      ended_at?: string;
    };

export interface LiveTurnSnapshot {
  chat_id: string;
  user_id: string;
  name: string;
  started_at: string;
  trigger_message_id?: string;
  items: LiveItem[];
  /** Роль сейчас думает (28.09.2026): последняя законченная фраза её
   *  размышлений, "" — думает, но фразы ещё нет; null — не думает. */
  thinking: string | null;
}

/** Расход хода (владелец 19.10.2026): строка под ответом в чате —
 *  скорость, входные/выходные токены, попадание в кэш, ориентировочная
 *  цена. `input` — без кэша; цена null — модель её не сообщает. */
export interface TurnUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  /** Время генерации (от первого токена до конца ответа) — для скорости. */
  generation_ms: number | null;
  model: string | null;
  /** Размер беседы на последнем обращении к модели (вход + кэш) — сколько
   *  модель перечитывает за шаг; сумма input за ход растёт с числом шагов. */
  context: number;
  /** Обращений к модели за ход. */
  calls: number;
}

/** То, что ложится в chat_messages.steps вместе с ответом. */
export interface SavedSteps {
  duration_ms: number;
  items: LiveItem[];
  usage?: TurnUsage;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

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

/** The gateway is transport; display the operation it actually invokes.
 * Keep the outer toolCallId so completion still closes this exact step. */
export function presentedToolCall(tool:string,args:unknown):{tool:string;args:unknown}{
 if(!args || typeof args!=="object")return {tool,args};
 const a=args as Record<string,unknown>;
 if(tool==="taskflow"){
  if(a.action==="invoke" && typeof a.operation==="string" && a.operation.trim()){
   return {tool:a.operation,args:a.arguments && typeof a.arguments==="object"?a.arguments:{}};
  }
  if(a.action==="discover")return {tool:"taskflow_discover",args:{query:a.query}};
  if(a.action==="describe")return {tool:"taskflow_describe",args:{name:a.operation}};
 }
 if(tool==="mcp" && typeof a.tool==="string")return {tool:a.tool,args:a.args};
 return {tool,args};
}
function gatewayResult(result:unknown):{ok?:boolean;data?:{state?:string}}|null{
 if(!result || typeof result!=="object")return null;
 const text=(result as {content?:Array<{type?:string;text?:string}>}).content?.find(c=>c.type==="text")?.text;
 if(!text)return null;
 try{
  const value=JSON.parse(text);
  return typeof value?.ok==="boolean"?value:null;
 }catch{return null;}
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
      // A filesystem path is not one base64 token. Redact each component,
      // otherwise /roles/.../skills/.../SKILL.md disappears as one long secret.
      if (raw) return clip(shortPath(raw).split("/").map(part=>redactSecrets(part)).join("/"));
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
      let arg: string | null = null;
      for (const k of ["title", "query", "text", "url", "name", "id"]) {
        if (str(k)) {
          arg = str(k);
          break;
        }
      }
      // Инструмент трекера, вызванный напрямую (`taskflow_taskflow_agents`),
      // без подписи был голым «Действием» (владелец 01.10.2026: «про
      // инструмент ничего не написано») — называем его по-человечески.
      raw = tool.startsWith("taskflow_")
        ? arg
          ? `${mcpToolTitle(tool)} — ${arg}`
          : mcpToolTitle(tool)
        : arg;
    }
  }
  return raw ? clip(redactSecrets(raw)) : null;
}

const MCP_TOOL_TITLES: Record<string, string> = {
  discover: "поиск доступной операции",
  describe: "параметры операции",
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

const THINKING_BUF_MAX = 2_000;
/** Одно размышление целиком — до этого предела, дальше не копим. */
const THINKING_TEXT_MAX = 16_000;

/** Последняя законченная фраза размышлений — её видно в чате, пока роль
 *  думает. Недописанную не берём: она дёргалась бы на каждом слове. */
export function lastThinkingPhrase(buf: string): string {
  const text = buf.replace(/[*_`#>]+/g, "");
  const parts = text.split(/(?<=[.!?…:])\s+|\n+/);
  const complete = /[.!?…:]\s*$|\n\s*$/.test(text) ? parts : parts.slice(0, -1);
  for (let i = complete.length - 1; i >= 0; i--) {
    const phrase = complete[i].trim();
    if (phrase.length >= 3) return clip(redactSecrets(phrase));
  }
  return "";
}

/** Строка быстрых ответов Помощника владельца («БЫСТРО: …») — служебная, её
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

/** Подпись для шага, сохранённого до 01.10.2026 без неё: инструмент трекера
 *  называем по имени, остальное оставляем как было. */
export function stepDetailFallback(tool: string, detail: string | null): string | null {
  if (detail || !tool.startsWith("taskflow_")) return detail;
  return mcpToolTitle(tool);
}

// ── Конверт ответа роли ───────────────────────────────────────────────
//
// Разбор конверта (JSON-контракт роли v1 и старый YAML-подобный вид) живёт в
// одном месте — src/lib/roleContractV1.ts, чтобы чат, живой ход, сдача этапа
// и предпросмотр списка чатов понимали ответ одинаково. Здесь остаётся тонкая
// обёртка: прежнее имя и прежнее поведение (снять конверт, оставить текст).

/** Снять конверт `ok/output/...` с ответа роли, оставив текст `output`. */
export function unwrapRoleEnvelope(text: string): string {
  return unwrapRoleEnvelopeText(text);
}

// ── Сам ход ─────────────────────────────────────────────────────────────

export class LiveTurn {
  readonly chatId: string;
  readonly userId: string;
  readonly name: string;
  private readonly triggerMessageId?: string;
  private readonly audience: () => string[];
  private readonly publish?: (turn: LiveTurnSnapshot | null) => void;
  private readonly startedAt = new Date();
  private items: LiveItem[] = [];
  /** Идущее размышление; null — роль сейчас не думает. */
  private thinkingItem: Extract<LiveItem, { kind: "thinking" }> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private usage: TurnUsage | null = null;
  /** Первый токен идущего ответа модели — начало генерации. */
  private genStartedAt: number | null = null;
  /** finish({ deferAnnounce }) отработал, «ход закончен» ещё не разослан. */
  private endPending = false;
  /** Ход-двойник: для этой пары уже идёт живой ход, этот ничего не
   *  рассылает и не трогает чужой снимок. */
  private readonly detached: boolean;

  constructor(args: {
    chatId: string;
    userId: string;
    name: string;
    triggerMessageId?: string;
    audience: () => string[];
    detached?: boolean;
    publish?: (turn: LiveTurnSnapshot | null) => void;
  }) {
    this.chatId = args.chatId;
    this.userId = args.userId;
    this.name = args.name;
    this.triggerMessageId = args.triggerMessageId;
    this.audience = args.audience;
    this.publish = args.publish;
    this.detached = args.detached ?? false;
    if (this.detached) this.closed = true;
  }

  /** Событие рантайма роли. Всё незнакомое молча пропускаем. */
  readonly onEvent = (event: unknown): void => {
    if (this.closed || !event || typeof event !== "object") return;
    traceCoordination(()=>coordinationActivity(this.triggerMessageId,this.userId,event));
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      isError?: boolean;
      result?: unknown;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    const sub = e.type === "message_update" ? e.assistantMessageEvent?.type : undefined;
    if (sub && this.genStartedAt === null) this.genStartedAt = Date.now();
    if (e.type === "message_end" || e.type === "turn_usage") this.addUsage(event);
    if (sub === "thinking_start") {
      this.endThinking();
      this.startThinking();
      this.schedule(true);
    } else if (sub === "thinking_delta") {
      const item = this.thinkingItem ?? this.startThinking();
      if (item && item.text.length < THINKING_TEXT_MAX) {
        item.text += e.assistantMessageEvent?.delta ?? "";
      }
      this.schedule(false);
    } else if (sub === "thinking_end") {
      this.endThinking();
      this.schedule(true);
    } else if (sub === "text_delta") {
      this.endThinking();
      this.appendText(e.assistantMessageEvent?.delta ?? "");
    } else if (e.type === "tool_execution_start" && e.toolName) {
      this.endThinking();
      if (this.items.length >= ITEMS_MAX) return;
      const presented=presentedToolCall(e.toolName,e.args);
      this.items.push({
        kind: "step",
        id: e.toolCallId || `step-${this.items.length}`,
        tool: presented.tool,
        detail: stepDetail(presented.tool, presented.args),
        args: ioArgs(presented.args),
        status: "running",
        started_at: new Date().toISOString(),
      });
      this.schedule(true);
    } else if (e.type === "tool_execution_end" && e.toolCallId) {
      const step = this.items.find(
        (it) => it.kind === "step" && it.id === e.toolCallId,
      );
      if (step && step.kind === "step") {
        const result=e.toolName==="taskflow"?gatewayResult(e.result):null;
        const state=result?.data?.state;
        step.status=e.isError || result?.ok===false || state==="unknown_outcome" ? "error"
          : state==="running" || state==="pending" ? "running" : "done";
        if(step.status!=="running")step.ended_at=new Date().toISOString();
        step.output=ioOutput(e.result);
        this.schedule(true);
      }
    }
  };

  /** Pi: message_end ответа модели несёт usage; внешний агент шлёт
   *  turn_usage итогом своего хода. Ходов модели за один ход чата
   *  бывает несколько (шаги с инструментами) — складываем. */
  private addUsage(event: unknown): void {
    const e = event as { type?: string; usage?: any; message?: any };
    let add: TurnUsage | null = null;
    if (e.type === "turn_usage" && e.usage) {
      const u = e.usage;
      add = {
        input: num(u.input), output: num(u.output),
        cache_read: num(u.cacheRead), cache_write: num(u.cacheWrite),
        cost_usd: typeof u.costUsd === "number" ? u.costUsd : null,
        generation_ms: typeof u.generationMs === "number" ? u.generationMs : null,
        model: typeof u.model === "string" ? u.model : null,
        context: num(u.contextTokens) || num(u.input) + num(u.cacheRead) + num(u.cacheWrite),
        calls: num(u.calls) || 1,
      };
    } else if (e.message?.role === "assistant" && e.message.usage) {
      const u = e.message.usage;
      const cost = u.cost && typeof u.cost.total === "number" ? u.cost.total : null;
      add = {
        input: num(u.input), output: num(u.output),
        cache_read: num(u.cacheRead), cache_write: num(u.cacheWrite),
        cost_usd: cost,
        generation_ms: this.genStartedAt === null ? null : Date.now() - this.genStartedAt,
        model: typeof e.message.model === "string" ? e.message.model : null,
        context: num(u.input) + num(u.cacheRead) + num(u.cacheWrite),
        calls: 1,
      };
    }
    this.genStartedAt = null;
    if (!add) return;
    const prev = this.usage;
    this.usage = prev
      ? {
          input: prev.input + add.input,
          output: prev.output + add.output,
          cache_read: prev.cache_read + add.cache_read,
          cache_write: prev.cache_write + add.cache_write,
          cost_usd: prev.cost_usd === null && add.cost_usd === null ? null : (prev.cost_usd ?? 0) + (add.cost_usd ?? 0),
          generation_ms: prev.generation_ms === null && add.generation_ms === null ? null : (prev.generation_ms ?? 0) + (add.generation_ms ?? 0),
          model: add.model ?? prev.model,
          context: add.context,
          calls: prev.calls + add.calls,
        }
      : add;
  }

  private startThinking(): Extract<LiveItem, { kind: "thinking" }> | null {
    if (this.items.length >= ITEMS_MAX) return null;
    const item: Extract<LiveItem, { kind: "thinking" }> = {
      kind: "thinking",
      id: `thinking-${this.items.length}`,
      tool: "thinking",
      text: "",
      status: "running",
      started_at: new Date().toISOString(),
    };
    this.items.push(item);
    this.thinkingItem = item;
    return item;
  }

  private endThinking(): void {
    const item = this.thinkingItem;
    if (!item) return;
    item.status = "done";
    item.ended_at = new Date().toISOString();
    this.thinkingItem = null;
  }

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
        const text = unwrapRoleEnvelope(stripQuickRepliesLine(it.text));
        if (text.trim()) items.push({ kind: "text", text });
      } else if (it.kind === "thinking") {
        // Законченное пустое размышление (модель скрыла текст) — не
        // показываем; идущее пустое — это «Думает…» без текста.
        if (it.status === "running" || it.text.trim()) {
          items.push({ ...it, text: redactSecrets(it.text) });
        }
      } else {
        items.push({ ...it });
      }
    }
    return {
      chat_id: this.chatId,
      user_id: this.userId,
      name: this.name,
      started_at: this.startedAt.toISOString(),
      ...(this.triggerMessageId ? { trigger_message_id: this.triggerMessageId } : {}),
      items,
      thinking: this.thinkingItem
        ? lastThinkingPhrase(this.thinkingItem.text.slice(-THINKING_BUF_MAX))
        : null,
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
    if (this.publish) { this.publish(this.snapshot()); return; }
    broadcastToUsers(this.audience(), {
      type: "chats:live",
      chat_id: this.chatId,
      user_id: this.userId,
      turn: this.snapshot(),
    });
  }

  /** Replace the final live draft with the validated text that will be saved. */
  replaceFinalText(text: string): void {
    if (this.closed) return;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item.kind === "text") {
        item.text = text;
        this.schedule(true);
        return;
      }
    }
    this.appendText(text);
    this.schedule(true);
  }

  /** Ход закончен (успешно или нет): убрать живой снимок у всех и отдать
   *  то, что сохранится в истории. Последний текстовый кусок — это сам
   *  ответ, он ляжет пузырём, поэтому в шаги не идёт. Ни шагов, ни
   *  размышлений — null: обычный короткий ответ без свёрнутой строки.
   *
   *  `deferAnnounce` — не рассылать «ход закончен» сразу: вызывающая
   *  сторона сначала сохранит ответ и разошлёт `chat:new`, а потом позовёт
   *  announceEnd(id). Так клиент меняет живой пузырь на готовый одним
   *  кадром, без мгновения пустоты между ними (то самое «дёрганье» в конце
   *  ответа). */
  finish(opts: { deferAnnounce?: boolean } = {}): SavedSteps | null {
    if (this.closed) return null;
    this.endThinking();
    this.closed = true;
    this.dispose();
    if (!this.publish) liveTurns.delete(keyOf(this.chatId, this.userId));
    if (!opts.deferAnnounce) this.broadcastEnd(null);
    else this.endPending = true;
    const items = this.snapshot().items;
    if (items.length && items[items.length - 1].kind === "text") items.pop();
    const now = new Date().toISOString();
    for (const it of items) {
      if (it.kind === "step" && it.status === "running") {
        it.status = "error";
        it.ended_at = now;
      }
    }
    const usage = this.usage && this.usage.input + this.usage.output > 0 ? this.usage : null;
    if (!usage && !items.some((it) => it.kind !== "text")) return null;
    return {
      duration_ms: Date.now() - this.startedAt.getTime(),
      items,
      ...(usage ? { usage } : {}),
    };
  }

  /** Разослать «ход закончен» после finish({ deferAnnounce: true }).
   *  messageId — сообщение, которым лёг ответ (null — ответа нет): клиент
   *  по нему понимает, что готовый пузырь уже у него и живой можно убрать. */
  announceEnd(messageId: string | null): void {
    if (!this.endPending) return;
    this.endPending = false;
    this.broadcastEnd(messageId);
  }

  private broadcastEnd(messageId: string | null): void {
    if (this.publish) { this.publish(null); return; }
    broadcastToUsers(this.audience(), {
      type: "chats:live",
      chat_id: this.chatId,
      user_id: this.userId,
      turn: null,
      message_id: messageId,
    });
  }

  /** Текст ответа, который роль успела написать, — для хода, остановленного
   *  владельцем: написанное не пропадает вместе с остановкой. */
  partialText(): string {
    const texts = this.items.filter((it) => it.kind === "text");
    const last = texts[texts.length - 1];
    return last && last.kind === "text"
      ? unwrapRoleEnvelope(stripQuickRepliesLine(last.text)).trim()
      : "";
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
  triggerMessageId?: string;
  audience: () => string[];
}): LiveTurn {
  const key = keyOf(args.chatId, args.userId);
  // Ход этой роли в чате уже идёт (второе сообщение Помощнику владельца подряд):
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
  if (code === "CHAT_RUN_CANCELLED") return "Остановлено.";
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
