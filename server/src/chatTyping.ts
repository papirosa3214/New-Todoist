// Отметка «печатает…» в чате координации (28.08.2026, владелец: «у меня в
// чате нету вообще никакой отметки о том, кто что в моменте там печатает, а
// она мне очень сильно нужна»).
//
// ПОЧЕМУ В ПАМЯТИ, А НЕ В БАЗЕ. Тот же довод, что у живой строки действий
// агента (routes/activity.ts): это состояние «прямо сейчас», у него нет
// истории и его нельзя пережить перезапуску — после рестарта никто не
// печатает по определению. Миграций здесь нет и быть не должно, хранение
// сообщений задача не трогает.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Отметку надо гасить, когда у участника закрылся
// последний сокет, а это знает ws.ts. Если бы реестр жил в routes/chat.ts,
// ws.ts пришлось бы импортировать маршруты — цикл (chat.ts уже импортирует
// ws.ts). Здесь связь односторонняя: этот модуль знает про ws.ts, ws.ts про
// него — нет, он только зовёт зарегистрированный обработчик onUserGone.
import db from "./db.js";
import { broadcastToUsers, onUserGone } from "./ws.js";

/**
 * Сколько живёт отметка без подтверждения.
 *
 * У человека сигнал шлёт строка ввода на каждое нажатие (с прореживанием),
 * поэтому срок короткий: перестал печатать — через несколько секунд гаснет
 * само, даже если браузер закрыли рубильником.
 *
 * У агента продлевать сигнал НЕЧЕМ: пока модель сочиняет ответ, она не
 * может параллельно дёрнуть инструмент — вызов идёт до генерации, а
 * следующий будет уже после. Поэтому один сигнал должен покрывать типичное
 * время ответа целиком, отсюда минута против восьми секунд.
 */
const TTL_HUMAN_MS = 8_000;
const TTL_AGENT_MS = 60_000;

/** Уборка протухших — реже, чем сроки: клиент гасит отметку своим таймером
 *  по ttl_ms, серверный обход нужен, чтобы карта не росла, и чтобы тот, кто
 *  открыл экран позже, не увидел покойника в снимке (GET). */
const SWEEP_MS = 3_000;

interface Typist {
  name: string;
  /** Когда отметка протухает, мс эпохи. */
  until: number;
  /** Свой срок участника — уезжает в событие, чтобы клиент гасил отметку
   *  тем же временем, каким её завёл сервер. */
  ttl: number;
}

const typists = new Map<string, Typist>();

/** Все участники канала: чат общий, отметку видят все — как и сообщения. */
function allUserIds(): string[] {
  return (
    db.prepare("SELECT id FROM users").all() as Array<{ id: string }>
  ).map((r) => r.id);
}

function userRow(userId: string): { name: string; type: string } | undefined {
  return db.prepare("SELECT name, type FROM users WHERE id = ?").get(userId) as
    { name: string; type: string } | undefined;
}

function emit(
  userId: string,
  name: string,
  state: "typing" | "stop",
  ttl: number,
) {
  broadcastToUsers(allUserIds(), {
    type: "chat:typing",
    user_id: userId,
    name,
    state,
    // Срок относительный, а не «до какого времени»: часы телефона и сервера
    // расходятся на секунды, и абсолютная метка гасила бы отметку раньше
    // времени или держала бы её лишнее.
    ttl_ms: ttl,
  });
}

/**
 * «Я готовлю сообщение». Повторный вызов продлевает — отдельного метода
 * продления нет намеренно: у человека это каждое нажатие клавиши, у агента —
 * повторный заход перед долгим ответом.
 */
export function startTyping(userId: string): { ttl_ms: number } | null {
  const row = userRow(userId);
  if (!row) return null;
  const ttl = row.type === "ai" ? TTL_AGENT_MS : TTL_HUMAN_MS;
  typists.set(userId, { name: row.name, until: Date.now() + ttl, ttl });
  emit(userId, row.name, "typing", ttl);
  return { ttl_ms: ttl };
}

/**
 * Погасить отметку. Зовётся из трёх мест: строка ввода опустела/потеряла
 * фокус, сообщение отправлено (см. POST /api/chat) и участник закрыл
 * последний сокет.
 */
export function stopTyping(userId: string): void {
  const entry = typists.get(userId);
  if (!entry) return;
  typists.delete(userId);
  emit(userId, entry.name, "stop", 0);
}

/** Снимок для того, кто ТОЛЬКО ЧТО открыл экран: событие про начало печати
 *  ушло до его подписки, и без снимка он увидел бы пустоту при живом
 *  собеседнике. Та же дыра и то же лечение, что у GET активности задачи. */
export function currentTypists(): Array<{
  user_id: string;
  name: string;
  ttl_ms: number;
}> {
  const now = Date.now();
  const out = [];
  for (const [userId, entry] of typists) {
    if (entry.until <= now) continue;
    out.push({ user_id: userId, name: entry.name, ttl_ms: entry.until - now });
  }
  return out;
}

// Ушёл со связи — отметка не должна пережить его. Сокет держат Максим в
// браузере и резидент канала; агенты с ключом сокета не держат вовсе и
// гаснут по сроку — это и есть их «отвалился».
onUserGone(stopTyping);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of typists) {
    if (entry.until <= now) {
      typists.delete(userId);
      emit(userId, entry.name, "stop", 0);
    }
  }
}, SWEEP_MS);
// Таймер уборки не повод держать процесс живым.
sweeper.unref?.();
