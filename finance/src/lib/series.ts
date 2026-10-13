/**
 * Чистая арифметика аналитики — отдельно от запросов к базе, чтобы её можно
 * было проверить тестами без поднятия приложения.
 *
 * Закрывает FIN-05: значение «накоплений» на одну дату не должно зависеть от
 * выбранного периода (дизайн-система, раздел 5 и чек-лист приёмки).
 */

/** Суммы меньше половины копейки не показываем: «−0,00 $» на экране — мусор. */
export const ZERO_TOLERANCE = 0.005;

export function isZeroAmount(value: number): boolean {
  return Math.abs(value) < ZERO_TOLERANCE;
}

/** Строки «валюта — сумма» без нулевых остатков. Валюты не складываются. */
export function amountsByCurrency(
  entries: Array<{ currency: string; value: number }>,
): Array<{ currency: string; value: number }> {
  const byCurrency = new Map<string, number>();
  for (const e of entries) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.value);
  return [...byCurrency.entries()]
    .filter(([, value]) => !isZeroAmount(value))
    .map(([currency, value]) => ({ currency, value: round2(value) }));
}

/** «RUB» первым — базовая валюта приложения, остальные по алфавиту. */
export function sortCurrencies(currencies: Iterable<string>): string[] {
  return [...new Set(currencies)].sort((a, b) => {
    if (a === "RUB") return -1;
    if (b === "RUB") return 1;
    return a.localeCompare(b);
  });
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ключ месяца «YYYY-MM» из даты «YYYY-MM-DD» или «YYYY-MM». */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Сдвиг месяца на n назад/вперёд, без перехода через границу года. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/** Список месяцев от from до to включительно. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  // месяцев в выборке не больше нескольких лет, цикл с предохранителем
  for (let guard = 0; guard < 600; guard++) {
    out.push(cursor);
    if (cursor === to) break;
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export type MonthlyPoint = { month: string; amount: number };

/** Минимум точек на графике накоплений: иначе на «Месяце» линия из одной точки. */
export const MIN_NET_WORTH_POINTS = 6;

/**
 * Накопления на конец каждого месяца окна.
 *
 * Значение точки зависит только от месяца и всей истории до него — выбранный
 * период задаёт лишь окно показа. Поэтому переключение периода не меняет сумму
 * на одну и ту же дату (FIN-05).
 *
 * @param monthlyNet суммы операций по месяцам с начала истории
 * @param openingByMonth начальные остатки счетов по месяцам, когда счёт действует
 * @param windowFrom первый показываемый месяц
 * @param windowTo последний показываемый месяц
 */
export function buildNetWorthSeries(args: {
  monthlyNet: Array<{ month: string; value: number }>;
  openingByMonth: Array<{ month: string; value: number }>;
  windowFrom: string;
  windowTo: string;
}): MonthlyPoint[] {
  const ops = cumulativeByMonth(args.monthlyNet);
  const opening = cumulativeByMonth(args.openingByMonth);

  // Начальное значение — итог на конец месяца перед окном: в окно попадает
  // только часть истории, а накопления копятся с самого начала. Месяц без
  // операций не обнуляет линию — значение держится, пока не пришла следующая.
  let opsCarry = valueBefore(ops, args.windowFrom);
  let openingCarry = valueBefore(opening, args.windowFrom);
  return monthRange(args.windowFrom, args.windowTo).map((month) => {
    opsCarry = ops.get(month) ?? opsCarry;
    openingCarry = opening.get(month) ?? openingCarry;
    return { month, amount: round2(opsCarry + openingCarry) };
  });
}

/** Кумулятивная сумма по месяцам: ключ — месяц, значение — итог на его конец. */
function cumulativeByMonth(rows: Array<{ month: string; value: number }>): Map<string, number> {
  const out = new Map<string, number>();
  let acc = 0;
  for (const row of [...rows].sort((a, b) => a.month.localeCompare(b.month))) {
    acc += row.value;
    out.set(row.month, acc);
  }
  return out;
}

/** Последний известный итог строго до месяца (карта заполнена по возрастанию). */
function valueBefore(map: Map<string, number>, month: string): number {
  let last = 0;
  for (const [key, value] of map) {
    if (key >= month) break;
    last = value;
  }
  return last;
}

/**
 * Окно показа накоплений: выбранный период, но не короче MIN_NET_WORTH_POINTS
 * месяцев, иначе на коротком периоде линия из одной точки ничего не говорит.
 */
export function netWorthWindow(args: { from: string; to: string }): {
  windowFrom: string;
  windowTo: string;
} {
  const to = monthKey(args.to);
  const floor = addMonths(to, -(MIN_NET_WORTH_POINTS - 1));
  const from = monthKey(args.from);
  // Окно — самое раннее из двух: иначе на «Месяце» линия из одной точки.
  return { windowFrom: from < floor ? from : floor, windowTo: to };
}