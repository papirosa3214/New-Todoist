/**
 * Форматирование чисел и дат для UI — раздел 5 дизайн-системы.
 * Единственный источник значений для всех экранов: ни одно число с деньгами
 * не выводится в разметке напрямую.
 */

const NBSP = "\u00A0";
const MINUS = "\u2212";

const moneyFormatter = new Map<string, Intl.NumberFormat>();

function moneyFormatterFor(currency: string): Intl.NumberFormat {
  let f = moneyFormatter.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    moneyFormatter.set(currency, f);
  }
  return f;
}

/** Минус типографский (U+2212), пробелы неразрывные — иначе суммы «прыгают». */
function tidy(raw: string): string {
  return raw.replace(/[\u00A0\u202F]/g, NBSP).replace(/^-/, MINUS);
}

export function formatMoney(amount: number, currency = "RUB"): string {
  return tidy(moneyFormatterFor(currency).format(amount));
}

/** Та же сумма с явным знаком: доход всегда со знаком «+». */
export function formatSignedMoney(amount: number, currency = "RUB"): string {
  const base = formatMoney(Math.abs(amount), currency);
  return `${amount < 0 ? MINUS : "+"}${base}`;
}

const compactUnits: Array<{ limit: number; suffix: string }> = [
  { limit: 1_000_000_000, suffix: "млрд" },
  { limit: 1_000_000, suffix: "млн" },
  { limit: 1_000, suffix: "тыс" },
];

/** Компактная запись для осей и подписей секторов: «−12,3 тыс ₽». */
export function formatMoneyCompact(amount: number, currency = "RUB"): string {
  const sign = amount < 0 ? MINUS : "";
  const abs = Math.abs(amount);
  const unit = compactUnits.find((u) => abs >= u.limit);
  const symbol = moneyFormatterFor(currency)
    .formatToParts(abs)
    .find((p) => p.type === "currency")?.value;
  if (!unit) return `${sign}${moneyFormatterFor(currency).format(abs)}`;
  const scaled = abs / unit.limit;
  const digits = scaled >= 100 ? 0 : 1;
  const num = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(scaled);
  return `${sign}${num}${NBSP}${unit.suffix}${NBSP}${symbol ?? ""}`.trim();
}

export function formatNumber(amount: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount);
}

/** Проценты: «42%», «12,4%». */
export function formatPercent(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value) + "%";
}

function parseIsoDate(iso: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly) {
    // Дату операции читаем как есть: без сдвига часового пояса.
    return new Date(Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]));
  }
  return new Date(iso);
}

function formatParts(iso: string, withTime: boolean): string {
  const date = parseIsoDate(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const d = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  if (!withTime) return d;
  const t = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${d},${NBSP}${t}`;
}

export function formatDate(iso: string): string {
  return formatParts(iso, false);
}

export function formatDateWithTime(iso: string): string {
  return formatParts(iso, true);
}

export function formatMonth(iso: string): string {
  const date = parseIsoDate(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const raw = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Русские числительные: plural(2, ["счёт","счёта","счетов"]) → «счёта». */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function pluralize(n: number, forms: [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}

/** Сегодня по московскому времени — UTC+3, в 00:00–03:00 МСК это вчера в UTC. */
export function todayIso(): string {
  const now = new Date();
  const msk = new Date(now.getTime() + (now.getTimezoneOffset() + 180) * 60_000);
  return msk.toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function dayMonth(msk: Date): string {
  const d = msk.getDate();
  const m = MONTHS_GENITIVE[msk.getMonth()];
  return `${d < 10 ? "0" + d : d}${NBSP}${m}`;
}

function periodRangeMsk(period: string): { from: Date; to: Date } {
  const now = new Date();
  const today = new Date(now.getTime() + (now.getTimezoneOffset() + 180) * 60_000);
  const from = new Date(today);
  switch (period) {
    case "week":
      from.setDate(today.getDate() - 6); // неделя = 7 дней, а не 8
      break;
    case "month":
      from.setMonth(today.getMonth() - 1);
      break;
    case "quarter":
      from.setMonth(today.getMonth() - 3);
      break;
    case "year":
      from.setFullYear(today.getFullYear() - 1);
      break;
    default: {
      const parts = period.split("_");
      if (parts.length === 2) {
        return { from: parseIsoDate(parts[0]), to: parseIsoDate(parts[1]) };
      }
      from.setMonth(today.getMonth() - 1);
    }
  }
  return { from, to: today };
}

/**
 * Границы периода по московскому времени — единственный источник истины.
 * «Неделя» = 7 дней (правило раздела 5), произвольный диапазон — «YYYY-MM-DD_YYYY-MM-DD».
 * Подпись периода и запросы аналитики берут границы отсюда, иначе они разъезжаются.
 */
export function periodRange(period: string): { from: string; to: string } {
  const { from, to } = periodRangeMsk(period);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** «Неделя · 06–12 октября», «Месяц · 13 сентября – 13 октября». */
export function periodLabel(period: string, range?: { from: string; to: string }): string {
  const names: Record<string, string> = {
    week: "Неделя",
    month: "Месяц",
    quarter: "Квартал",
    year: "Год",
  };
  const name = names[period] ?? "Период";
  const edges = range ?? periodRange(period);
  return `${name} · ${dayMonth(parseIsoDate(edges.from))} – ${dayMonth(
    parseIsoDate(edges.to),
  )}`;
}