// Local-date helpers shared across screens. Using local (not UTC) date
// parts so "today" matches the user's wall clock, not UTC midnight.

import type { ApiTask } from "../api/types";

export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Adds/subtracts whole days from a "YYYY-MM-DD" string, returning the same
// format. Goes through a local Date so month/year rollovers are correct.
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function tomorrowStr(): string {
  return addDays(todayStr(), 1);
}

// Канонический источник сокращённых названий месяцев (родительный падеж
// без точки: "янв", "авг" — используется в датах задач по всему
// приложению). Раньше был продублирован буквально в InboxScreen.tsx,
// ProjectTasksScreen.tsx, TaskBoard.tsx, TodayScreen.tsx, UpcomingScreen.tsx
// — теперь импортируется отсюда. НЕ путать с MONTHS_ABBR_DOT в
// UpcomingScreen.tsx (другой формат: "Янв.", "Авг." — с точкой и заглавной,
// используется только в заголовке ленты календаря того экрана) — это
// разные наборы для разных мест, не дубль друг друга.
export const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

// "Срок" row label: relative word for near dates + short date, matching the
// mockup's New Task screen row ("Завтра, 11 авг.", mockup-reference/index.html
// line 1141).
export function formatDueLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const month = MONTHS_SHORT[d.getMonth()];
  if (dateStr === todayStr()) return `Сегодня, ${day} ${month}.`;
  if (dateStr === tomorrowStr()) return `Завтра, ${day} ${month}.`;
  // Год показываем ТОЛЬКО когда он не текущий (18.08.2026, владелец
  // запланировал задачу на 2027 и увидел «4 сент.» — по такой подписи год не
  // отличить, и срок читается как «через две недели» вместо «через год»).
  // В текущем году год не пишем: он избыточен и удлиняет бейджи в списках.
  const currentYear = new Date().getFullYear();
  const year = d.getFullYear();
  if (year !== currentYear) return `${day} ${month} ${year}`;
  return `${day} ${month}.`;
}

/** Сколько суток до срока: 0 — сегодня, 1 — завтра, отрицательное — просрочено. */
export function daysUntil(dateStr: string): number {
  // Считаем по календарным суткам, а не по часам: «через сутки» и «завтра» —
  // разные вещи, а человека интересует именно день. Обе даты приводятся к
  // полуночи, поэтому переход через ночь всегда даёт ровно ±1, без дробей и
  // без зависимости от того, в котором часу открыли приложение.
  const цель = new Date(dateStr + "T00:00:00");
  const сегодня = new Date(todayStr() + "T00:00:00");
  return Math.round((цель.getTime() - сегодня.getTime()) / 86_400_000);
}

/** «осталось 3 дня» / «сегодня» / «просрочено на 2 дня» — короткой строкой. */
export function formatDaysLeft(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  if (d === -1) return "вчера";
  // Русские окончания: 1 день, 2-4 дня, 5+ дней — плюс исключение для
  // 11-14, где по правилу всегда «дней» (одиннадцать дней, а не «день»).
  const n = Math.abs(d);
  const сотня = n % 100;
  const единица = n % 10;
  const слово =
    сотня >= 11 && сотня <= 14
      ? "дней"
      : единица === 1
        ? "день"
        : единица >= 2 && единица <= 4
          ? "дня"
          : "дней";
  return d > 0 ? `осталось ${n} ${слово}` : `просрочено на ${n} ${слово}`;
}

// ═══════════ TIMESTAMPS (comments, notifications, activity, …) ═══════════
// Canonical home for these two — they used to live only in
// ../api/notifications.ts (re-exported from there for backward
// compatibility so its existing import sites don't need touching).

// `created_at` on every table is SQLite's `datetime('now')`:
// "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker. `new Date(...)`
// would parse that as *local* time, which is off by the local UTC offset
// (e.g. 3h in Moscow). Normalize before parsing.
export function parseServerDate(sqliteDatetime: string): Date {
  return new Date(sqliteDatetime.replace(" ", "T") + "Z");
}

// ═══════════ "Сегодня" screen: overdue/today split ═══════════
// Single source for "what counts as overdue vs. due today" on the Today
// screen — used by both its list layout (the red "Просрочено" block above
// the regular rows, added earlier per a direct product requirement) and
// its board layout (two columns, same names, same order). Keeping this in
// one place means the two layouts can never quietly disagree about which
// task belongs where. Overdue tasks come back oldest-due-first, matching
// how the list has always shown them.
export function partitionOverdueToday(
  tasks: ApiTask[],
  today: string,
): { overdue: ApiTask[]; todayTasks: ApiTask[] } {
  const overdue = tasks
    .filter(
      (t) => t.status === "active" && t.due_date !== null && t.due_date < today,
    )
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  const todayTasks = tasks.filter(
    (t) => t.due_date === today && t.status === "active",
  );
  return { overdue, todayTasks };
}

// "5 мин. назад" / "вчера" style relative label for any SQLite
// `created_at` string. Use this instead of printing the raw value —
// comments/notifications/activity should never show raw
// "YYYY-MM-DD HH:MM:SS" to the user.
export function formatRelativeTime(sqliteDatetime: string): string {
  const d = parseServerDate(sqliteDatetime);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин. назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч. назад`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return "вчера";
  return `${diffD} дн. назад`;
}
