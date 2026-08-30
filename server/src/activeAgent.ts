// Отпечаток активности агента (29.08.2026, задача 31f2759e).
//
// Что здесь:
//   - Map в памяти: кто, когда в последний раз стучался, что делал и
//     над чем (название задачи, чтобы в подписи «Команды» владелец видел
//     читабельное, а не технический id — 29.08.2026).
//   - Троттлинг записи в users.last_seen_at (30с): иначе каждый запрос
//     пишет в БД, при активной работе десятки записей в минуту впустую.
//   - Продление agent_heartbeat_at делает НЕ этот модуль: аренда живёт
//     на конкретной задаче и продлевается только когда запрос относится к
//     ней же (см. routes/chat.ts:600 и routes/tasks.ts — POST /heartbeat).
//     Общий перехватчик её трогать не должен: иначе карточка, брошенная
//     агентом, продолжала бы гореть «в работе», пока он просто читает
//     доску.
//
// Положение в коде. Сборщик вызывается из authOrApiToken (auth.ts:176),
// единственной точки, через которую проходит КАЖДЫЙ запрос любого
// агента с ключом. Это и есть та самая «единая точка входа» из задачи:
// больше ниоткуда собирать не нужно.

import db from "./db.js";

interface ActiveRecord {
  /** Когда пришёл последний запрос, мс эпохи. */
  lastSeenAt: number;
  /** Человеческое описание маршрута: «читает задачу», «пишет в чат»… */
  lastAction: string;
  /** Название задачи, к которой обращение (если есть). */
  lastActionTitle: string;
  /** Когда last_seen_at в последний раз писался в БД, мс эпохи. */
  dirtyAt: number;
}

const records = new Map<string, ActiveRecord>();

/** Сколько секунд тишины между запросами считаем нормой. Если больше —
 *  отметка «работает» гаснет (вычисляется во фронте по lastSeenAt,
 *  реального side-эффекта здесь нет).
 *  Подобрано под типичный ход агента: чтение доски, чат, шаги — это
 *  десятки секунд, не минуты; минута — потолок для длинного раздумья. */
const STALE_AFTER_MS = 60_000;

/** Минимальный интервал между записями в users.last_seen_at. Свежие
 *  запросы идут лавиной, и каждый в БД — лишняя нагрузка. 30с — мера,
 *  которая держит «последний сигнал» живым, но не долбит SQLite. */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * Разобрать req.method + req.url в человеческое описание действия. Набор
 * ограничен теми маршрутами, которые агент действительно использует;
 * всё прочее идёт как «работает» — точность не нужна, нужна живая подпись.
 */
function describeAction(method: string, url: string): string {
  const m = (method || "GET").toUpperCase();
  const path = url.split("?")[0] || "/";

  // Чат: GET /api/chat — читает; POST — пишет.
  if (path === "/api/chat" || path.startsWith("/api/chat/")) {
    if (m === "GET") return "читает чат";
    if (m === "POST") return "пишет в чат";
    return "работает с чатом";
  }
  // Доска и задачи.
  if (path === "/api/tasks" || path === "/api/tasks/") {
    if (m === "GET") return "читает доску";
    if (m === "POST") return "заводит задачу";
    return "работает с доской";
  }
  // /api/tasks/:id — основная работа по карточке.
  const taskMatch = path.match(/^\/api\/tasks\/([0-9a-fA-F-]{36})(\/.*)?$/);
  if (taskMatch) {
    const tail = taskMatch[2] || "";
    if (m === "GET") return "читает задачу";
    if (tail === "/claim") return "берёт задачу";
    if (tail === "/state") return "меняет состояние задачи";
    if (tail === "/comments") {
      if (m === "POST") return "пишет комментарий";
      return "читает комментарии";
    }
    if (tail === "/subtasks") {
      if (m === "POST") return "заводит шаг";
      return "работает с шагами";
    }
    if (tail.startsWith("/subtasks/")) {
      if (m === "PATCH") return "закрывает шаг";
      if (m === "POST") return "берёт шаг";
      return "работает с шагом";
    }
    if (tail === "/heartbeat") return "продлевает аренду";
    if (tail === "/activity") return "читает ленту задачи";
    if (m === "PATCH") return "правит задачу";
    return "работает с задачей";
  }
  // Подзадачи верхнего уровня.
  if (path === "/api/subtasks" || path.startsWith("/api/subtasks/")) {
    if (m === "PATCH") return "закрывает шаг";
    if (m === "POST") return "берёт шаг";
    return "работает с шагами";
  }
  // Агенты / команда.
  if (path.startsWith("/api/agents")) return "смотрит команду";
  // Уведомления.
  if (path.startsWith("/api/notifications")) {
    if (m === "GET") return "читает уведомления";
    return "работает с уведомлениями";
  }
  // Документация.
  if (path.startsWith("/api/docs")) return "пишет документацию";
  if (path.startsWith("/api/projects")) return "работает с проектами";

  // Fallback — точность не нужна, нужна живая подпись.
  return "работает";
}

/** Достать название задачи по id из БД. Кэш в памяти: одна и та же задача
 *  в длинной работе дёргается десятки раз, и БД каждый раз дёргать не
 *  надо. TTL — 5 минут, чтобы переименование задачи отразилось за
 *  разумное время. */
const titleCache = new Map<string, { title: string; cachedAt: number }>();
const TITLE_TTL_MS = 5 * 60_000;

function taskTitle(taskId: string): string {
  const hit = titleCache.get(taskId);
  const now = Date.now();
  if (hit && now - hit.cachedAt < TITLE_TTL_MS) return hit.title;
  const row = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as
    { title?: string } | undefined;
  const title = (row?.title || "").trim();
  titleCache.set(taskId, { title, cachedAt: now });
  return title;
}

/** Достать task_id из URL. Только для маршрутов с id в пути. */
function taskIdFromUrl(url: string): string {
  const m = url.match(/^\/api\/tasks\/([0-9a-fA-F-]{36})(\/.*)?$/);
  if (m) return m[1];
  const m2 = url.match(/^\/api\/subtasks\/([0-9a-fA-F-]{36})(\/.*)?$/);
  return m2 ? "" : "";  // подзадачи сами по себе в подпись не идут — нужна родительская
}

/** Публичный вход: вызывается из authOrApiToken на каждый запрос.
 *  Не бросает — если БД не ответит, отметка активности не запишется, но
 *  запрос пройдёт (это лучше, чем ронять авторизацию из-за счётчика). */
export function touchActive(userId: string, method: string, url: string): void {
  const now = Date.now();
  const action = describeAction(method, url);
  const tid = taskIdFromUrl(url);
  const title = tid ? taskTitle(tid) : "";

  const prev = records.get(userId);
  records.set(userId, {
    lastSeenAt: now,
    lastAction: action,
    lastActionTitle: title,
    dirtyAt: prev?.dirtyAt ?? 0,
  });

  // Запись в users.last_seen_at — не чаще раза в FLUSH_INTERVAL_MS.
  // БД-обновление НЕ блокирует основной путь: если сейчас не время —
  // просто откладываем до следующего вызова.
  if (now - (prev?.dirtyAt ?? 0) >= FLUSH_INTERVAL_MS) {
    try {
      const iso = new Date(now).toISOString();
      db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(iso, userId);
      const cur = records.get(userId);
      if (cur) cur.dirtyAt = now;
    } catch {
      // БД недоступна — на следующем запросе попробуем снова.
    }
  }
}

/** Снимок для GET /api/agents и WS-событий. Тихий для людей — у них
 *  клиент и так знает, что это он сам, и в БД их писать незачем. */
export interface ActiveSnapshot {
  userId: string;
  online: boolean;
  lastSeenAt: number | null;
  lastAction: string;
  lastActionTitle: string;
}

function userType(userId: string): "ai" | "human" | null {
  const row = db.prepare("SELECT type FROM users WHERE id = ?").get(userId) as
    { type?: string } | undefined;
  return (row?.type as "ai" | "human") ?? null;
}

export function snapshot(): ActiveSnapshot[] {
  const now = Date.now();
  const out: ActiveSnapshot[] = [];
  for (const [userId, rec] of records) {
    const t = userType(userId);
    if (t !== "ai") continue;                       // людей пропускаем
    const online = now - rec.lastSeenAt <= STALE_AFTER_MS;
    out.push({
      userId,
      online,
      lastSeenAt: rec.lastSeenAt,
      lastAction: rec.lastAction,
      lastActionTitle: rec.lastActionTitle,
    });
  }
  return out;
}

/** Снимок одного агента. Для владельца — пусто, ему эта информация
 *  не нужна. */
export function snapshotFor(userId: string): ActiveSnapshot | null {
  const t = userType(userId);
  if (t !== "ai") return null;
  const rec = records.get(userId);
  if (!rec) return null;
  const now = Date.now();
  return {
    userId,
    online: now - rec.lastSeenAt <= STALE_AFTER_MS,
    lastSeenAt: rec.lastSeenAt,
    lastAction: rec.lastAction,
    lastActionTitle: rec.lastActionTitle,
  };
}
