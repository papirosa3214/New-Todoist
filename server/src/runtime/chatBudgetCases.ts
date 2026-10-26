// Приватные карточки разбора для бюджета действий пункта (100 + 50).
//
// Смысл: у пункта плана есть 100 основных действий. Когда они кончаются,
// ход роли перезапускается в новой сессии ещё на 50 действий — но материалы
// первого хода (события, системный промпт, файл сессии) не должны потеряться.
// Они складываются в приватную карточку разбора в таблице chat_budget_cases.
// Автозапуска из карточки нет: продолжение делает вызывающий код через
// budgetContinuationPrompt, а материалы кладёт safelyCaptureBudgetCases.
//
// Карточка приватная: её читает владелец и сама роль при продолжении,
// в дерево разделов и в обычные списки она не попадает.

import crypto from "node:crypto";
import db from "../db.js";

/**
 * Схема приватных карточек разбора. Применяется миграцией
 * `179_chat_budget_cases` (см. migrations.ts).
 */
export const BUDGET_CASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_budget_cases (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 chat_id TEXT NOT NULL,
 role_id TEXT NOT NULL,
 item_id TEXT,
 title TEXT,
 used INTEGER NOT NULL DEFAULT 0,
 base INTEGER NOT NULL DEFAULT 0,
 total INTEGER NOT NULL DEFAULT 0,
 materials INTEGER NOT NULL DEFAULT 0,
 session_file TEXT,
 system_prompt TEXT,
 events TEXT,
 error TEXT
);
CREATE INDEX IF NOT EXISTS chat_budget_cases_chat ON chat_budget_cases(chat_id, role_id);
CREATE INDEX IF NOT EXISTS chat_budget_cases_created ON chat_budget_cases(created_at);
`;

export type BudgetCaseInput = {
  id: string;
  chatId: string;
  roleId: string;
  itemId?: string | null;
  title?: string | null;
  used?: number;
  base?: number;
  total?: number;
};

export type BudgetMaterials = {
  sessionFile?: string | null;
  systemPrompt?: string | null;
  events?: unknown;
  error?: { code?: string | null; message?: string | null } | string | null;
};

export type BudgetCaseRow = {
  id: string;
  chat_id: string;
  role_id: string;
  item_id: string | null;
  title: string | null;
  used: number;
  base: number;
  total: number;
  materials: number;
  session_file: string | null;
  system_prompt: string | null;
  events: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** Открыть карточку разбора: базовые действия кончились, начат дополнительный ход. */
export function openBudgetCase(input: BudgetCaseInput): void {
  db.prepare(
    "INSERT OR REPLACE INTO chat_budget_cases(id,chat_id,role_id,item_id,title,used,base,total) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    input.id,
    input.chatId,
    input.roleId,
    input.itemId ?? null,
    input.title ?? null,
    input.used ?? 0,
    input.base ?? 0,
    input.total ?? 0,
  );
}

/** Учесть ещё одно действие в открытой карточке. */
export function updateBudgetCase(caseId: string, used: number): void {
  db.prepare("UPDATE chat_budget_cases SET used=?, updated_at=datetime('now') WHERE id=?").run(used, caseId);
}

function errorText(error: BudgetMaterials["error"]): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  return [error.code, error.message].filter(Boolean).join(": ") || null;
}

function latestCase(chatId: string, roleId: string): BudgetCaseRow | undefined {
  return db.prepare(
    "SELECT * FROM chat_budget_cases WHERE chat_id=? AND role_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(chatId, roleId) as BudgetCaseRow | undefined;
}

/**
 * Сохранить материалы хода в приватную карточку разбора.
 *
 * Никогда не бросает: вызывается из finally и из обработчика исчерпания бюджета,
 * где потеря материалов не должна ломать иначе нормальный ход.
 */
export function safelyCaptureBudgetCases(
  chatId: string,
  roleId: string,
  materials: BudgetMaterials,
): void {
  try {
    const row = latestCase(chatId, roleId);
    if (!row) return;
    db.prepare(
      "UPDATE chat_budget_cases SET session_file=?, system_prompt=?, events=?, error=?, materials=1, updated_at=datetime('now') WHERE id=?",
    ).run(
      materials.sessionFile ?? null,
      materials.systemPrompt ?? null,
      materials.events === undefined ? null : JSON.stringify(materials.events),
      errorText(materials.error),
      row.id,
    );
  } catch (error) {
    console.warn("[chatBudgetCases] материалы хода не сохранены:", error);
  }
}

/**
 * Промпт продолжения: роль начинает новую сессию с теми же 50 действиями.
 *
 * `null`, когда продолжать нечего: карточки разбора нет.
 */
export function budgetContinuationPrompt(chatId: string, roleId: string): string | null {
  const row = latestCase(chatId, roleId);
  if (!row) return null;
  const left = Math.max(0, row.total - row.used);
  return [
    "Продолжение пункта «" + (row.title ?? "без названия") + "»: основные " + row.base + " действий израсходованы,",
    "в этом ходе доступно ещё " + left + " действий.",
    "Материалы предыдущего хода сохранены в приватной карточке разбора (id: " + row.id + ").",
    "Сначала прочитай сохранённые материалы, затем продолжай исходное поручение с того места, где остановился.",
  ].join("\n");
}

/**
 * Наблюдатель за карточками без материалов.
 *
 * Карточка без материалов — это ход, который исчерпал бюджет и не отдал
 * материалы (перезапуск сервера, обрыв сессии). Один раз в сутки владельцу
 * приходит напоминание. Автозапуска хода не делает: продолжение решает
 * владелец или роль.
 */
export function startBudgetCaptureWatcher(): () => void {
  const check = () => {
    try {
      const pending = db.prepare(
        "SELECT id, chat_id, role_id, title FROM chat_budget_cases WHERE materials=0 AND created_at<=datetime('now', '-30 minutes') LIMIT 20",
      ).all() as Array<{ id: string; chat_id: string; role_id: string; title: string | null }>;
      for (const row of pending) {
        const type = "chat_budget_case_pending";
        const already = db.prepare(
          "SELECT 1 FROM notifications WHERE type=? AND created_at>=datetime('now', '-1 day') LIMIT 1",
        ).get(type);
        if (already) return;
        for (const owner of db.prepare("SELECT id FROM users WHERE role='owner'").all() as { id: string }[]) {
          db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(
            crypto.randomUUID(),
            owner.id,
            type,
            "Карточка разбора «" + (row.title ?? "без названия") + "» ждёт материалов хода (" + row.role_id + "). Продолжение не запущено.",
          );
        }
        return;
      }
    } catch (error) {
      console.warn("[chatBudgetCases] наблюдатель карточек разбора не отработал:", error);
    }
  };
  check();
  const timer = setInterval(check, 15 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}