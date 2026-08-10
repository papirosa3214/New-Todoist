// Local-date helpers shared across screens. Using local (not UTC) date
// parts so "today" matches the user's wall clock, not UTC midnight.

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

const MONTHS_SHORT = [
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
  return `${day} ${month}.`;
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
