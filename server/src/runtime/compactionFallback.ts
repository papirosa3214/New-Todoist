/**
 * Безопасная компакция сессии Pi (25.10.2026).
 *
 * Запрос выжимки уходит одним большим текстом: Pi склеивает всю старую часть
 * истории в одно user-сообщение (SDK core/compaction/compaction.js,
 * generateSummaryWithUsage). На тяжёлой истории — мегабайты результатов
 * инструментов — он не укладывается в таймаут провайдера («Request timed out.»)
 * и ход роли падает; раньше мы шли дальше на сырой истории, и следующий запрос
 * был тяжелее и тоже умирал. Здесь: режем запрос и, если выжимка не вышла,
 * пишем локальную выжимку — ход продолжается.
 */

/** Пределы уреза истории и выжимки. */
export const DEFAULT_COMPACTION_LIMITS = {
  targetContextChars: 80_000, // к чему стремимся после уреза
  minMessageChars: 400,
  maxMessageChars: 4_000,
  goalChars: 4_000, // цель — первая реплика пользователя
  recentMessages: 24, // столько последних сообщений держим подробно
  recentChars: 4_000,
  roleChars: { user: 4_000, assistant: 4_000, toolResult: 2_000 },
  thinkingChars: 1_000,
  toolCallArgsChars: 400,
  localKeepMessages: 24, // столько последних сообщений оставляет локальная выжимка
  // Порог, выше которого запрос выжимки к модели не отправляем вовсе: он идёт
  // одним большим текстом и на тяжёлой истории роняется по таймауту провайдера
  // или по «410 ModelDeprecated». Лучше локальный урез, чем минуты тишины.
  maxCompactInputChars: 120_000,
  summaryTailMessages: 4, // столько последних реплик диалога попадает в локальную выжимку
  summaryTailChars: 600,
  summaryTools: 12, // сколько разных инструментов перечисляем в локальной выжимке
};
export type CompactionLimits = typeof DEFAULT_COMPACTION_LIMITS;

/** Пределы выжимки для Pi: короткий ответ (Pi берёт 0.8*reserveTokens) и небольшой оставленный хвост. */
export const COMPACTION_SETTINGS = { enabled: true, reserveTokens: 4_096, keepRecentTokens: 16_000 } as const;

export const COMPACTION_INSTRUCTIONS =
  "Кратко, не больше 10 предложений: цель, ключевые решения, сделанные изменения, следующий шаг. Вывод инструментов не пересказывай.";

/** Сводка по истории: всего символов (текст + размышления + аргументы вызовов) и сколько сообщений. */
export function measureMessages(messages: any[] | undefined): { chars: number; count: number } {
  const list = messages ?? [];
  let chars = 0;
  for (const message of list) {
    const content = message?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === "string") chars += block.text.length;
        else if (typeof block?.thinking === "string") chars += block.thinking.length;
        else if (block?.type === "toolCall") chars += JSON.stringify(block.arguments ?? "").length;
      }
    }
  }
  return { chars, count: list.length };
}

/** Обрезка текста с пометкой, сколько символов выкинули. */
export function truncateText(text: string, max: number): string {
  if (typeof text !== "string" || max <= 0) return "";
  if (text.length <= max) return text;
  const marker = `\n…[обрезано ${text.length - max} симв.]…\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.max(1, Math.floor(room * 0.7));
  const tail = Math.max(0, room - head);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

/** Обрезка аргументов вызова: длинные полезные нагрузки (markdown, планы) занимают
 * больше, чем весь разговор, а для выжимки они шум. JSON остаётся валидным. */
export function capToolCallArguments(args: any, max: number): any {
  if (max <= 0 || args === null || typeof args !== "object") return args;
  let changed = false;
  const walk = (value: any, depth: number): any => {
    if (typeof value === "string") {
      const capped = value.length <= max ? value : `${value.slice(0, max)}…[обрезано ${value.length - max} симв.]`;
      if (capped !== value) changed = true;
      return capped;
    }
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => walk(item, depth + 1));
    if (value && typeof value === "object" && depth < 6) {
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, item] of Object.entries(value)) {
        if (count++ >= 100) break;
        out[key] = walk(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  const capped = walk(args, 0);
  return changed ? capped : args;
}

/**
 * Урезает одно сообщение: текст режется по общему потолку, размышления
 * выкидываются целиком (подпись относится к исходному тексту — обрезанный
 * провайдер не примет), вызовы не выкидываются, но их аргументы обрезаются.
 */
export function trimMessage(message: any, caps: { cap: number; thinking: number; toolCallArgs: number }): { message: any; truncated: boolean } {
  if (!message || typeof message !== "object") return { message, truncated: false };
  const content = message.content;
  if (typeof content === "string") {
    const next = truncateText(content, caps.cap);
    return { message: next === content ? message : { ...message, content: next }, truncated: next !== content };
  }
  if (!Array.isArray(content)) return { message, truncated: false };
  let remaining = caps.cap;
  let truncated = false;
  const blocks: any[] = [];
  for (const block of content) {
    if (block?.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      const next = remaining > 0 ? truncateText(text, remaining) : "";
      remaining -= next.length;
      if (next !== text) truncated = true;
      blocks.push({ ...block, text: next });
    } else if (block?.type === "thinking") {
      if ((typeof block.thinking === "string" ? block.thinking : "").length > caps.thinking) truncated = true;
      else blocks.push(block);
    } else if (block?.type === "toolCall") {
      const args = capToolCallArguments(block.arguments, caps.toolCallArgs);
      if (args !== block.arguments) truncated = true;
      blocks.push({ ...block, arguments: args });
    } else {
      blocks.push(block);
    }
  }
  return { message: truncated ? { ...message, content: blocks } : message, truncated };
}

/**
 * План уреза истории: цель (первая реплика пользователя) и последние ходы
 * остаются подробными, старая середина режется равномерно.
 */
export function planHistoryTrim(messages: any[] | undefined, limits: CompactionLimits = DEFAULT_COMPACTION_LIMITS): {
  messages: any[]; charsBefore: number; charsAfter: number; truncatedMessages: number;
} {
  const list = messages ?? [];
  const count = list.length;
  const charsBefore = measureMessages(list).chars;
  const uniformCap = count > 0
    ? Math.min(limits.maxMessageChars, Math.max(limits.minMessageChars, Math.floor(limits.targetContextChars / count)))
    : limits.maxMessageChars;
  const goalIndex = list.findIndex((message) => message?.role === "user");
  const recentFrom = Math.max(0, list.length - limits.recentMessages);
  let truncatedMessages = 0;
  const trimmed = list.map((message, index) => {
    const special = index === goalIndex ? limits.goalChars : index >= recentFrom ? limits.recentChars : uniformCap;
    const role = message?.role === "user" ? limits.roleChars.user : message?.role === "assistant" ? limits.roleChars.assistant : limits.roleChars.toolResult;
    const result = trimMessage(message, {
      cap: Math.min(Math.max(uniformCap, special), role),
      thinking: limits.thinkingChars,
      toolCallArgs: limits.toolCallArgsChars,
    });
    if (result.truncated) truncatedMessages += 1;
    return result.message;
  });
  return { messages: trimmed, charsBefore, charsAfter: measureMessages(trimmed).chars, truncatedMessages };
}

/**
 * Локальная выжимка без модели: цель, последний ответ роли и размер истории.
 * Её пишем в compaction-запись — следующий запрос к модели будет маленьким, а
 * роль понимает, чем занималась.
 */
export function buildLocalSummary(messages: any[] | undefined, limits: CompactionLimits = DEFAULT_COMPACTION_LIMITS): string {
  const list = messages ?? [];
  const stats = measureMessages(list);
  const text = (message: any): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b: any) => typeof b?.text === "string").map((b: any) => b.text).join("\n");
  };
  const goalText = text(list.find((message) => message?.role === "user")).trim();
  const lastText = text([...list].reverse().find((message) => message?.role === "assistant")).trim();
  // Хвост диалога: без него роль после уреза не знает, на чём остановилась.
  const tail = list
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-limits.summaryTailMessages)
    .map((message) => {
      const who = message?.role === "user" ? "владелец" : "роль";
      const body = text(message).trim();
      return body ? `${who}: ${truncateText(body, limits.summaryTailChars)}` : "";
    })
    .filter(Boolean);
  // Инструменты: что роль делала в этом ходе — один взгляд вместо всех выдач.
  const tools = new Map<string, number>();
  let toolCalls = 0;
  for (const message of list) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall") continue;
      toolCalls += 1;
      const name = String(block.name ?? "инструмент");
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  const toolLine = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.summaryTools)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  return [
    "[Локальная выжимка истории: LLM-компакция не прошла, ход продолжается на урезанной истории.]",
    `Сообщений: ${stats.count}, объём: ${stats.chars} симв., вызовов инструментов: ${toolCalls}.`,
    goalText ? `Цель: ${truncateText(goalText, limits.goalChars)}` : "",
    lastText ? `Последний ответ роли: ${truncateText(lastText, limits.roleChars.assistant)}` : "",
    tail.length ? `Хвост диалога:\n${tail.join("\n")}` : "",
    toolLine ? `Инструменты: ${toolLine}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Контекст сессии — то, что уходит в модель. */
export function readContextMessages(session: any): any[] {
  const context = session?.sessionManager?.buildSessionContext?.();
  if (Array.isArray(context?.messages)) return context.messages;
  const state = session?.agent?.state?.messages;
  return Array.isArray(state) ? state : [];
}

/**
 * Пары «вызов инструмента — результат» должны остаться целыми: провайдер
 * отклоняет запрос, если в контексте есть результат без его вызова
 * («tool result's tool id not found») или вызов без результата. Половины,
 * потерявшие пару, убираем.
 */
export function repairToolPairs(messages: any[] | undefined): any[] {
  const list = messages ?? [];
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of list) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && block.id) callIds.add(String(block.id));
      }
    } else if (message?.role === "toolResult" && message.toolCallId) {
      resultIds.add(String(message.toolCallId));
    }
  }
  const repaired: any[] = [];
  for (const message of list) {
    if (message?.role === "toolResult") {
      if (message.toolCallId && !callIds.has(String(message.toolCallId))) continue;
      repaired.push(message);
      continue;
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const blocks = message.content.filter(
        (block: any) => !(block?.type === "toolCall" && block.id && !resultIds.has(String(block.id))),
      );
      if (blocks.length === message.content.length) {
        repaired.push(message);
        continue;
      }
      if (!blocks.length) continue;
      repaired.push({ ...message, content: blocks });
      continue;
    }
    repaired.push(message);
  }
  return repaired;
}

/** Урезает контекст в памяти: в модель уходит только то, что нужно. */
function trimContext(session: any, limits: CompactionLimits): number {
  const trimmed = repairToolPairs(planHistoryTrim(readContextMessages(session), limits).messages);
  if (trimmed.length && session?.agent?.state) session.agent.state.messages = trimmed;
  return measureMessages(trimmed).chars;
}

/**
 * Локальная компакция без модели: пишем compaction-запись с коротким
 * пересказом и оставляем последние ходы. Запись Pi разводит контекст: старая
 * часть выпадает из запроса, и следующая попытка выжимки видит малый вход.
 */
export function applyLocalCompaction(session: any, limits: CompactionLimits = DEFAULT_COMPACTION_LIMITS): {
  ok: boolean; charsAfter: number; summary: string;
} {
  const manager = session?.sessionManager;
  if (!manager) return { ok: false, charsAfter: 0, summary: "" };
  const messageEntries = (manager.getBranch?.() ?? []).filter((entry: any) => entry?.type === "message");
  // Граница уреза не должна разрезать пару «вызов — результат»: если первым
  // остаётся результат инструмента, сдвигаем границу назад к его вызову.
  const roleOf = (entry: any): string | undefined => entry?.message?.role ?? entry?.role;
  let keepFrom = Math.max(0, messageEntries.length - limits.localKeepMessages);
  while (keepFrom > 0 && roleOf(messageEntries[keepFrom]) === "toolResult") keepFrom -= 1;
  const firstKeptEntryId = messageEntries[keepFrom]?.id;
  if (!firstKeptEntryId) return { ok: false, charsAfter: 0, summary: "" };
  const messages = readContextMessages(session);
  const summary = buildLocalSummary(messages, limits);
  manager.appendCompaction(summary, firstKeptEntryId, Math.round(measureMessages(messages).chars / 4), undefined, true);
  return { ok: true, charsAfter: trimContext(session, limits), summary };
}

/**
 * Безопасная компакция: ход роли не должен падать из-за тяжёлой истории.
 * 1. Штатная выжимка Pi с явными пределами (COMPACTION_SETTINGS).
 * 2. Не вышла (таймаут провайдера) — локальный урез без модели: пишем свою
 *    выжимку, контекст собираем заново, ход продолжается.
 * 3. «Nothing to compact» — не поломка: истории нечего сжимать.
 */
export async function compactSessionSafely(
  session: any,
  ctx: { label: string; limits?: CompactionLimits; log?: (message: string) => void },
): Promise<{ mode: "skipped" | "compacted" | "fallback"; charsBefore: number; charsAfter: number; error?: string }> {
  const limits = ctx.limits ?? DEFAULT_COMPACTION_LIMITS;
  const log = ctx.log ?? ((message: string) => console.warn(message));
  const before = measureMessages(readContextMessages(session)).chars;
  // Тяжёлый вход: запрос выжимки к модели не отправляем (он уйдёт одним
  // большим текстом и уронит ход по таймауту или «410 ModelDeprecated»).
  // Режем локально — ход продолжается на маленькой истории.
  if (before > limits.maxCompactInputChars) {
    const local = applyLocalCompaction(session, limits);
    log(
      `[compact] ${ctx.label}: контекст ${before} симв. > порога ${limits.maxCompactInputChars} — ` +
        `локальный урез без модели, тяжёлый запрос выжимки не отправляем.`,
    );
    return {
      mode: local.ok ? "fallback" : "skipped",
      charsBefore: before,
      charsAfter: local.charsAfter || before,
      error: `input too large for model compaction (${before} > ${limits.maxCompactInputChars})`,
    };
  }
  try {
    await session.compact(COMPACTION_INSTRUCTIONS);
    return { mode: "compacted", charsBefore: before, charsAfter: trimContext(session, limits) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/nothing to compact|already compacted/i.test(message)) {
      return { mode: "skipped", charsBefore: before, charsAfter: before };
    }
    const local = applyLocalCompaction(session, limits);
    log(`[compact] ${ctx.label}: выжимка не прошла (${message}); локальный урез истории ${before} → ${local.charsAfter} симв.`);
    return {
      mode: local.ok ? "fallback" : "skipped",
      charsBefore: before,
      charsAfter: local.charsAfter || before,
      error: message,
    };
  }
}
