// Уборка разросшихся таблиц: журнал идемпотентности инструментов и
// снимки шагов хода роли.
//
// Аудит 24.10.2026: после уборки манифестов инструкций (48 МБ → 9 МБ)
// следующими по объёму шли role_tool_requests (13 МБ) и chat_messages
// (34 МБ). Разбираем оба.
//
// ── role_tool_requests ──────────────────────────────────────────────────
// Это ЖУРНАЛ ИДЕМПОТЕНТНОСТИ: role_tool_requests хранит результат каждого
// вызова инструмента, чтобы повтор того же request_id не выполнил
// операцию второй раз. Ключ request_id формируется как
// `runId + ":" + id` (roleToolCatalog.ts) — то есть он уникален ВНУТРИ
// одного хода роли. Ход длится минуты-часы; повтор с тем же request_id
// после суток невозможен: следующий ход получит новый runId.
//
// Срок: 7 дней. Это с запасом перекрывает самый длинный ход (план с
// ожиданием владельца) и даёт время разобрать инцидент по журналу.
//
// Что НЕ удаляем: записи в состоянии running — по ним сторож
// toolErrorAccountingWatcher считает зависшие вызовы. Их чистим только
// по тому же сроку (зависший вызов старше недели — точно мёртвый).
//
// ── chat_messages.steps ──────────────────────────────────────────────────
// steps — снимок хода роли: список шагов (kind:"step") и размышлений
// (kind:"thinking"). Размышления — это поток сознания модели, на
// который смотрит только живой ход (GET /api/chats/:id/live), а из
// истории чата UI их не читает ни веб-клиент, ни iOS (проверено grep'ом
// по обоим). В базе же они копились: 84 сообщения с steps > 100 КБ,
// до 750 КБ в одном, суммарно 19 МБ.
//
// Что делаем: при записи в БД обрезаем текст размышления до предела
// (оставляем начало — по нему видно, о чём роль думала в начале хода),
// а у уже накопленных записей — то же. Шаги (kind:"step") не трогаем:
// в них аргументы и ответы инструментов, и владелец разбирает по ним
// сбой конкретного шага (19.10.2026).
//
// Остальное в chat_messages (текст сообщений, координация, конверты)
// не трогаем — это история переписки.
import db from "../db.js";

/** Журнал идемпотентности: сколько дней хранить. */
export const TOOL_REQUEST_RETENTION_DAYS = 7;

/** Предел текста размышления в снимке хода (байт). */
export const THINKING_TEXT_LIMIT = 2_000;

/**
 * Сколько размышлений (kind:"thinking") оставляем в снимке хода.
 *
 * Замер (24.10.2026): одно сообщение — 200 items, из них 85 размышлений
 * (150 КБ) и 105 шагов (306 КБ). Размышления копились потоком за весь ход
 * (иногда сотни), и каждый item — это JSON с обвязкой, поэтому весили они
 * больше, чем их текст. UI эти размышления не читает (ни веб-клиент, ни
 * iOS): живой ход показывает их вживую через /api/chats/:id/live, а из
 * истории их никто не берёт.
 *
 * Оставляем первые — начало хода (что роль задумала) — и пишем, сколько
 * отброшено, чтобы по данным было видно, что список неполный.
 */
export const THINKING_ITEMS_LIMIT = 20;

/** Как часто проходить уборку (мс). Раз в сутки. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Обрезает размышления в снимке хода.
 *
 * Меняет структуру на месте: у каждого item с kind:"thinking" текст
 * обрезается до THINKING_TEXT_LIMIT с пометкой, что он обрезан (чтобы
 * по данным было видно, что текст не полный, и не путать обрезанное с
 * полным).
 */
export function trimThinkingItems(steps: any): any {
  if (!steps || typeof steps !== "object") return steps;
  const items = (steps as any).items;
  if (!Array.isArray(items)) return steps;
  let обрезано = 0;
  for (const item of items) {
    if (!item || item.kind !== "thinking") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.length <= THINKING_TEXT_LIMIT) continue;
    item.text = text.slice(0, THINKING_TEXT_LIMIT);
    item.text_truncated = true;
    item.text_original_length = text.length;
    обрезано += 1;
  }
  // Размышлений в ходе бывают сотни, а UI их не читает — оставляем начало
  // хода, остальное отбрасываем. Шаги (kind:"step") не трогаем: по ним
  // владелец разбирает сбой конкретного шага.
  const размышления = items.filter((i: any) => i && i.kind === "thinking");
  if (размышления.length > THINKING_ITEMS_LIMIT) {
    const оставить = new Set(размышления.slice(0, THINKING_ITEMS_LIMIT));
    const отброшено = размышления.length - THINKING_ITEMS_LIMIT;
    (steps as any).items = items.filter(
      (i: any) => !i || i.kind !== "thinking" || оставить.has(i),
    );
    (steps as any).thinking_items_dropped = отброшено;
    (steps as any).thinking_items_total = размышления.length;
  }
  if (обрезано > 0) (steps as any).thinking_truncated_count = обрезано;
  return steps;
}

/**
 * Убирает старые записи журнала идемпотентности.
 *
 * Возвращает, сколько записей удалено.
 */
export function pruneToolRequests(days = TOOL_REQUEST_RETENTION_DAYS): number {
  const есть = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_tool_requests'",
    )
    .get();
  if (!есть) return 0;
  const res = db
    .prepare(
      `DELETE FROM role_tool_requests
        WHERE datetime(created_at) < datetime('now', ?)`,
    )
    .run(`-${days} days`);
  return res.changes;
}

/**
 * Обрезает накопленные размышления в уже записанных снимках ходов.
 *
 * Возвращает, сколько записей обрезано.
 */
export function trimStoredThinking(): number {
  const есть = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_messages'",
    )
    .get();
  if (!есть) return 0;
  // Только крупные записи: мелкие не трогаем (дешевле и меньше риска).
  const строки = db
    .prepare(
      `SELECT id, steps FROM chat_messages
        WHERE steps IS NOT NULL AND LENGTH(steps) > ?
        ORDER BY rowid`,
    )
    .all(THINKING_TEXT_LIMIT * 4) as Array<{ id: string; steps: string }>;
  const обновить = db.prepare("UPDATE chat_messages SET steps = ? WHERE id = ?");
  let обрезано = 0;
  for (const с of строки) {
    let parsed: any;
    try {
      parsed = JSON.parse(с.steps);
    } catch {
      continue;
    }
    const был = с.steps.length;
    const trimmed = trimThinkingItems(parsed);
    if (!trimmed) continue;
    const стал = JSON.stringify(trimmed).length;
    if (стал >= был) continue;
    обновить.run(JSON.stringify(trimmed), с.id);
    обрезано += 1;
  }
  return обрезано;
}

/**
 * Полный проход уборки. Вызывается при старте сервера и по таймеру.
 */
export function runRetention(): { toolRequests: number; thinkingTrimmed: number } {
  const toolRequests = pruneToolRequests();
  const thinkingTrimmed = trimStoredThinking();
  return { toolRequests, thinkingTrimmed };
}

/**
 * Таймер уборки. Возвращает функцию остановки.
 *
 * Обслуживание не должно ронять сервер: любая ошибка — в журнал, дальше
 * работаем.
 */
export function startRetention(): () => void {
  const timer = setInterval(() => {
    try {
      const итог = runRetention();
      if (итог.toolRequests || итог.thinkingTrimmed) {
        console.log(
          `[retention] убрано записей журнала: ${итог.toolRequests}, обрезано снимков ходов: ${итог.thinkingTrimmed}`,
        );
      }
    } catch (error) {
      console.warn("[retention] уборка не прошла:", error);
    }
  }, RETENTION_INTERVAL_MS);
  // Таймер не должен держать процесс живым при остановке.
  timer.unref?.();
  return () => clearInterval(timer);
}
