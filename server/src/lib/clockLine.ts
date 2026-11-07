// Текущее время для ролей (владелец 14.10.2026): в рабочих ходах и в чате
// роли не знали ни даты, ни времени, а время в данных трекера хранится в UTC
// без пометки — «13:22» принимали за московское, хотя это 16:22.
const MOSCOW = "Europe/Moscow";

export function clockLine(now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const weekday = new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, weekday: "long" }).format(now);
  return `Сейчас: ${date}, ${weekday}, ${time} по Москве (UTC+3). Время в данных трекера (created_at, updated_at, история) указано в UTC — владельцу называй московское.`;
}
