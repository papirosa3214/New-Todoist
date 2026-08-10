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
