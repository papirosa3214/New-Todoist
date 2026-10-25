// Выжимка чата (карточка 252c400e, этап «чат»).
//
// Зачем: обычный чат умеет прервать прежнюю работу и продолжить с новым
// контекстом. Продолжение не должно тащить в новую сессию сырую историю
// прежних размышлений модели: после прерывания нужен короткий, проверяемый
// снимок — ровно три раздела:
//
//   1. Что было
//   2. Цель и задача
//   3. Что выполнить
//
// Правила (закреплены архитектором в карточке 252c400e):
//   • блоки thinking в выжимку не попадают никогда — фильтр здесь, а не
//     просьба модели;
//   • действия превращаются в факты («действие X → результат Y»);
//     незавершённое действие — в явную неопределённость, а не в молчание;
//   • выжимка хранится долговременно (chat_checkpoints) и привязана к
//     поколению сессии: поколение уехало — выжимка устарела;
//   • если выжимку построить не удалось, запуск на сырой истории ЗАПРЕЩЁН:
//     лучше явная ошибка, чем молчаливый возврат к сырому контексту.
//
// Модуль намеренно без сети и без моделей: выжимка собирается из того,
// что сервер уже знает (сообщения чата и шаги хода). Живой модельный вызов
// для суммаризации в этот этап не входит — владелец отдельно не согласовал
// лимиты и живой прогон.

import db from "../db.js";
import { currentChatGeneration } from "./chatQueue.js";

/** Заголовки разделов выжимки — порядок фиксирован. */
export const CHECKPOINT_SECTION_TITLES = [
  "Что было",
  "Цель и задача",
  "Что выполнить",
] as const;

export interface CheckpointSections {
  /** Что было: факты прошлого — сообщения и действия. */
  was: string;
  /** Цель и задача: что владелец просил, дословно и по сути. */
  goal: string;
  /** Что выполнить: что делать дальше, включая неизвестные эффекты. */
  next: string;
}

export interface CheckpointFact {
  /** «действие X → результат Y» либо строка сообщения. */
  text: string;
  /** true — факт неполный (действие начато, результат неизвестен). */
  uncertain?: boolean;
}

export interface CheckpointInput {
  /** Сообщения владельца — по сути цель. */
  ownerMessages: Array<{ text: string; createdAt?: string }>;
  /** Ответы роли — что уже было сделано. */
  roleMessages: Array<{
    text: string;
    createdAt?: string;
    /** Шаги хода: kind:"step" (действие) или kind:"thinking" (размышление). */
    steps?: unknown;
  }>;
  /** Незавершённые действия (ход прерван на середине). */
  pendingActions?: string[];
}

/** Сколько последних сообщений роли и владельца попадает в выжимку. */
const OWNER_MESSAGE_LIMIT = 6;
const ROLE_MESSAGE_LIMIT = 6;

/**
 * Шаги хода → факты. Размышления (kind:"thinking") выбрасываются целиком;
 * действия (kind:"step") превращаются в «действие X → результат Y».
 * Незавершённое действие (нет результата) — явная неопределённость.
 */
export function stepsToFacts(steps: unknown): CheckpointFact[] {
  const facts: CheckpointFact[] = [];
  const items = extractStepItems(steps);
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    if (kind === "thinking") continue; // размышления в выжимку не попадают
    if (kind !== "step") continue;
    const step = item as { tool?: unknown; status?: unknown; output?: unknown; detail?: unknown };
    const tool = typeof step.tool === "string" ? step.tool : "действие";
    const status = typeof step.status === "string" ? step.status : "";
    const result = firstString(step.output, step.detail);
    if (result) {
      facts.push({ text: `действие ${tool} → ${result}` });
      continue;
    }
    if (status === "running" || status === "error") {
      facts.push({ text: `действие ${tool} начато, результат неизвестен`, uncertain: true });
    }
  }
  return facts;
}

function extractStepItems(steps: unknown): unknown[] {
  if (!steps) return [];
  let parsed: unknown = steps;
  if (typeof steps === "string") {
    try {
      parsed = JSON.parse(steps);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const items = (parsed as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
    const stepsField = (parsed as { steps?: unknown }).steps;
    if (Array.isArray(stepsField)) return stepsField;
  }
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function clip(text: string, max = 400): string {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

/**
 * Собрать выжимку из известного состояния чата.
 *
 * Пустая выжимка — честный ответ «контекста нет»: вернуть её нельзя,
 * вызывающий код обязан остановиться с ошибкой, а не начать на сырой истории.
 */
export function buildCheckpointSections(input: CheckpointInput): CheckpointSections {
  const owner = input.ownerMessages.slice(-OWNER_MESSAGE_LIMIT);
  const roles = input.roleMessages.slice(-ROLE_MESSAGE_LIMIT);

  const wasFacts: string[] = [];
  for (const message of roles) {
    const facts = stepsToFacts(message.steps);
    for (const fact of facts) wasFacts.push(fact.text);
    const text = clip(message.text, 600);
    if (text) wasFacts.push(`ответ роли: ${text}`);
  }
  for (const pending of input.pendingActions ?? []) {
    const text = clip(pending, 300);
    if (text) wasFacts.push(`действие ${text} начато, результат неизвестен`);
  }

  const goalLines = owner.map((message) => clip(message.text, 600)).filter(Boolean);
  const nextLines: string[] = [];
  const lastOwner = owner[owner.length - 1];
  if (lastOwner) nextLines.push(`продолжить по последней просьбе владельца: ${clip(lastOwner.text, 400)}`);
  for (const pending of input.pendingActions ?? []) {
    const text = clip(pending, 300);
    if (text) nextLines.push(`уточнить результат действия ${text}: результат неизвестен`);
  }
  nextLines.push("не повторять уже выполненное без новой просьбы владельца");

  return {
    was: wasFacts.length ? wasFacts.join("\n") : "(действий и ответов не зафиксировано)",
    goal: goalLines.length ? goalLines.join("\n") : "(просьба владельца не зафиксирована)",
    next: nextLines.join("\n"),
  };
}

/** Текст выжимки для новой сессии: ровно три раздела, в фиксированном порядке. */
export function renderCheckpointPrompt(sections: CheckpointSections): string {
  return [
    "Выжимка прежнего разговора в чате (три раздела).",
    "",
    `1. ${CHECKPOINT_SECTION_TITLES[0]}`,
    sections.was,
    "",
    `2. ${CHECKPOINT_SECTION_TITLES[1]}`,
    sections.goal,
    "",
    `3. ${CHECKPOINT_SECTION_TITLES[2]}`,
    sections.next,
  ].join("\n");
}

/**
 * Разобрать текст выжимки, полученный от модели: все три заголовка должны
 * присутствовать. Нет заголовка — выжимка не принята (сырой текст в новую
 * сессию не идёт).
 */
export function parseCheckpointSections(text: string): CheckpointSections | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const found = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const title = CHECKPOINT_SECTION_TITLES.find(
      (candidate) =>
        trimmed === candidate ||
        trimmed === `1. ${candidate}` ||
        trimmed === `2. ${candidate}` ||
        trimmed === `3. ${candidate}` ||
        trimmed.toLowerCase() === candidate.toLowerCase(),
    );
    if (title) {
      current = title;
      found.set(title, []);
      continue;
    }
    if (current) found.get(current)!.push(line);
  }
  if (CHECKPOINT_SECTION_TITLES.some((title) => !found.has(title))) return null;
  const section = (title: string) => (found.get(title) ?? []).join("\n").trim();
  return {
    was: section(CHECKPOINT_SECTION_TITLES[0]),
    goal: section(CHECKPOINT_SECTION_TITLES[1]),
    next: section(CHECKPOINT_SECTION_TITLES[2]),
  };
}

export interface StoredCheckpoint extends CheckpointSections {
  generation: number;
  version: number;
  createdAt: string;
}

/** Сохранить выжимку для поколения. На поколение — одна выжимка. */
export function saveCheckpoint(input: {
  chatId: string;
  roleId: string;
  generation: number;
  sections: CheckpointSections;
  sourceRunId?: string | null;
  sourceLeafId?: string | null;
}): void {
  db.prepare(
    `INSERT INTO chat_checkpoints
       (chat_id, role_id, generation, version, sections_json, source_run_id, source_leaf_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id, role_id, generation) DO UPDATE SET
       version=excluded.version,
       sections_json=excluded.sections_json,
       source_run_id=excluded.source_run_id,
       source_leaf_id=excluded.source_leaf_id,
       created_at=excluded.created_at`,
  ).run(
    input.chatId,
    input.roleId,
    input.generation,
    1,
    JSON.stringify(input.sections),
    input.sourceRunId ?? null,
    input.sourceLeafId ?? null,
  );
}

/** Прочитать выжимку поколения. */
export function readCheckpoint(
  chatId: string,
  roleId: string,
  generation: number,
): StoredCheckpoint | null {
  const row = db
    .prepare(
      `SELECT generation, version, sections_json, created_at FROM chat_checkpoints
        WHERE chat_id=? AND role_id=? AND generation=?`,
    )
    .get(chatId, roleId, generation) as
    | { generation: number; version: number; sections_json: string; created_at: string }
    | undefined;
  if (!row) return null;
  let parsed: CheckpointSections;
  try {
    parsed = JSON.parse(row.sections_json) as CheckpointSections;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return { ...parsed, generation: row.generation, version: row.version, createdAt: row.created_at };
}

/** Выжимка, пригодная для текущего поколения. Уехавшее поколение — устарело. */
export function freshCheckpoint(
  chatId: string,
  roleId: string,
): StoredCheckpoint | null {
  const generation = currentChatGeneration(chatId, roleId);
  const stored = readCheckpoint(chatId, roleId, generation);
  if (!stored) return null;
  return stored;
}

/** Снять выжимку поколения (после того, как она отработала). */
export function clearCheckpoint(chatId: string, roleId: string, generation: number): void {
  db.prepare(
    "DELETE FROM chat_checkpoints WHERE chat_id=? AND role_id=? AND generation=?",
  ).run(chatId, roleId, generation);
}

/** Собрать выжимку из истории чата и сохранить её на текущее поколение. */
export function buildAndStoreCheckpoint(input: {
  chatId: string;
  roleId: string;
  ownerMessages: Array<{ text: string; createdAt?: string }>;
  roleMessages: Array<{ text: string; createdAt?: string; steps?: unknown }>;
  pendingActions?: string[];
  sourceRunId?: string | null;
  sourceLeafId?: string | null;
}): StoredCheckpoint {
  const sections = buildCheckpointSections(input);
  const generation = currentChatGeneration(input.chatId, input.roleId);
  saveCheckpoint({
    chatId: input.chatId,
    roleId: input.roleId,
    generation,
    sections,
    sourceRunId: input.sourceRunId ?? null,
    sourceLeafId: input.sourceLeafId ?? null,
  });
  return { ...sections, generation, version: 1, createdAt: new Date().toISOString() };
}

/**
 * Собрать выжимку из истории чата в БД: сообщения владельца (дословно) и
 * ответы роли вместе с шагами хода. Размышления модели в шагах выбрасываются
 * (см. stepsToFacts), сырая история сессии Pi сюда не попадает.
 *
 * `roleId` — учётка роли, чьи ответы считаем «что было». Сообщения других
 * участников в выжимку не идут: она — про работу этой роли.
 */
export function collectChatHistory(input: {
  chatId: string;
  roleId: string;
  limit?: number;
}): {
  ownerMessages: Array<{ text: string; createdAt?: string }>;
  roleMessages: Array<{ text: string; createdAt?: string; steps?: unknown }>;
} {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 100)));
  const rows = db
    .prepare(
      `SELECT from_user_id, text, created_at, steps FROM chat_messages
        WHERE chat_id = ? AND channel = 'chat'
        ORDER BY rowid ASC
        LIMIT ?`,
    )
    .all(input.chatId, limit) as Array<{
    from_user_id: string;
    text: string;
    created_at: string;
    steps: string | null;
  }>;
  const ownerMessages: Array<{ text: string; createdAt?: string }> = [];
  const roleMessages: Array<{ text: string; createdAt?: string; steps?: unknown }> = [];
  for (const row of rows) {
    if (row.from_user_id === input.roleId) {
      roleMessages.push({
        text: row.text,
        createdAt: row.created_at,
        steps: row.steps ? row.steps : undefined,
      });
      continue;
    }
    if (row.from_user_id.startsWith("role_")) continue; // ответ другой роли
    ownerMessages.push({ text: row.text, createdAt: row.created_at });
  }
  return { ownerMessages, roleMessages };
}

/**
 * Собрать и сохранить выжимку по истории чата — на текущее поколение пары
 * (чат, роль).
 */
export function buildCheckpointForChat(input: {
  chatId: string;
  roleId: string;
  pendingActions?: string[];
  sourceRunId?: string | null;
  sourceLeafId?: string | null;
}): StoredCheckpoint {
  const history = collectChatHistory({ chatId: input.chatId, roleId: input.roleId });
  return buildAndStoreCheckpoint({
    chatId: input.chatId,
    roleId: input.roleId,
    ownerMessages: history.ownerMessages,
    roleMessages: history.roleMessages,
    pendingActions: input.pendingActions,
    sourceRunId: input.sourceRunId ?? null,
    sourceLeafId: input.sourceLeafId ?? null,
  });
}

/** Как продолжать ход после того, как поколение сессии разошлось с текущим. */
export type ChatResumeMode =
  /** Продолжаем ту же сессию: поколение совпадает. */
  | "continue"
  /** Старая сессия мертва: нужен свежий ход с выжимкой. */
  | "fresh"
  /** Старая сессия мертва, а выжимки нет: продолжать нельзя — сырая
   *  история запрещена, ход не запускается. */
  | "blocked";

export interface ChatResumePlan {
  mode: ChatResumeMode;
  reason: string;
}

/**
 * Решение «продолжать старую сессию или начать свежую с выжимкой».
 *
 * Правило простое и обязательное: поколение сессии совпало с текущим —
 * продолжаем; разошлось — сырую историю в новый ход не тащим, нужен свежий
 * ход с трёхсекционной выжимкой; выжимки нет — ход не идёт вовсе (молча
 * вернуться к сырой истории нельзя).
 */
export function planChatResume(input: {
  savedGeneration: number | null;
  currentGeneration: number;
  hasCheckpoint: boolean;
}): ChatResumePlan {
  if (input.savedGeneration === null) {
    return { mode: "continue", reason: "сессии ещё не было" };
  }
  if (input.savedGeneration >= input.currentGeneration) {
    return { mode: "continue", reason: "поколение сессии совпадает" };
  }
  if (!input.hasCheckpoint) {
    return {
      mode: "blocked",
      reason: "прежняя сессия устарела, а выжимка не собрана — сырая история запрещена",
    };
  }
  return { mode: "fresh", reason: "прежняя сессия устарела — свежий ход с выжимкой" };
}

/**
 * Выжимка, перенесённая в следующий ход той же роли.
 *
 * Обычный чат устроен так: сообщение владельца открывает ветку, и роль
 * отвечает уже в ней. Прерванная работа при этом остаётся в прежней
 * ветке — её контекст должен перейти в новый ход, иначе роль начинает
 * заново. Перенос делаем явно и в памяти процесса: он живёт ровно один
 * ход (следующий).
 */
const carried = new Map<string, { sourceChatId: string; roleId: string }>();

/** Ключ переноса: роль + корневая комната разговора. */
function carryKey(roleId: string, rootChatId: string): string {
  return `${roleId}:${rootChatId}`;
}

/**
 * Запомнить, откуда взять выжимку для следующего хода роли.
 *
 * Саму выжимку собираем ЛЕНИВО, в начале следующего хода: прерванный ход
 * дописывает частичный ответ в историю после остановки, и выжимка, собранная
 * в момент остановки, его бы не увидела.
 */
export function carryCheckpoint(input: {
  roleId: string;
  rootChatId: string;
  sourceChatId: string;
}): void {
  carried.set(carryKey(input.roleId, input.rootChatId), {
    sourceChatId: input.sourceChatId,
    roleId: input.roleId,
  });
}

/** Забрать указание на перенос (одноразово) и собрать выжимку по нему. */
export function takeCarriedCheckpoint(
  roleId: string,
  rootChatId: string,
): StoredCheckpoint | null {
  const key = carryKey(roleId, rootChatId);
  const pointer = carried.get(key) ?? null;
  carried.delete(key);
  if (!pointer) return null;
  try {
    return buildCheckpointForChat({
      chatId: pointer.sourceChatId,
      roleId: pointer.roleId,
    });
  } catch {
    return null;
  }
}

/** Тестовая утилита: сбросить переносы. */
export function _resetCarriedCheckpointsForTests(): void {
  carried.clear();
}
