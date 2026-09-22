// Доставка обновлений в Dynamic Island, пока приложение свёрнуто.
//
// Почему без библиотеки: всё нужное есть в самом Node — http2 для соединения с
// Apple и crypto для подписи. Зависимость ради двух десятков строк тянуть в
// проект незачем, а `node-apn` к тому же давно не обновляется.
//
// Как это работает целиком:
//   1. приложение запускает активность с pushType .token (LiveActivityPlugin);
//   2. iOS выдаёт токен именно этой активности, приложение шлёт его на
//      /api/live-activity/token (routes/live-activity.ts);
//   3. сервер на каждое изменение задачи шлёт сюда обновление, и карточка
//      на заблокированном экране/в островке едет сама.
// Пока приложение открыто, то же самое делает фронт напрямую — пуш нужен
// ровно для свёрнутого состояния, когда JS не выполняется.
//
// НАСТРОЙКА (без неё модуль просто молчит, ничего не ломая):
//   APNS_KEY_P8    — содержимое ключа .p8 от Apple (или APNS_KEY_PATH — путь)
//   APNS_KEY_ID    — идентификатор ключа, 10 символов
//   APNS_TEAM_ID   — идентификатор команды разработчика
//   APNS_BUNDLE_ID — по умолчанию com.maksim.taskflow
//   APNS_ENV       — sandbox | prod | auto (по умолчанию auto)
// Ключ .p8 — секрет: его место в хранилище, а не в репозитории; сюда он
// приходит переменной окружения.

import crypto from "crypto";
import fs from "fs";
import http2 from "http2";
import db from "./db.js";

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.maksim.taskflow";
// Тема для ActivityKit — не сам bundle id, а он же с суффиксом. С обычным
// bundle id Apple отвечает отказом «TopicDisallowed».
const TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;

const HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  prod: "https://api.push.apple.com",
} as const;
type ApnsEnv = keyof typeof HOSTS;

// Секунды между 1970-01-01 и 2001-01-01. Swift кодирует Date числом секунд от
// своей точки отсчёта, и ContentState на устройстве разбирается обычным
// JSONDecoder — пришли мы Unix-время или строку ISO, дата уехала бы на 31 год.
const APPLE_EPOCH_OFFSET = 978_307_200;

function readKey(): string | null {
  const inline = process.env.APNS_KEY_P8;
  if (inline && inline.includes("BEGIN PRIVATE KEY")) return inline;
  const path = process.env.APNS_KEY_PATH;
  if (path && fs.existsSync(path)) return fs.readFileSync(path, "utf8");
  return null;
}

const KEY_PEM = readKey();
const KEY_ID = process.env.APNS_KEY_ID || "";
const TEAM_ID = process.env.APNS_TEAM_ID || "";
export const apnsConfigured = !!(KEY_PEM && KEY_ID && TEAM_ID);

if (!apnsConfigured) {
  console.log(
    "[apns] ключ не настроен — островок будет обновляться только при открытом приложении",
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Apple разрешает переиспользовать токен авторизации до часа и ругается
// «TooManyProviderTokenUpdates», если выпускать его на каждый запрос.
let cachedJwt: { token: string; issuedAt: number } | null = null;
function providerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 45 * 60) return cachedJwt.token;

  const header = base64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
  const payload = base64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    // ieee-p1363 — та самая пара r||s, которую ждёт JOSE. По умолчанию Node
    // подписывает в DER, и Apple такой токен не принимает.
    { key: crypto.createPrivateKey(KEY_PEM!), dsaEncoding: "ieee-p1363" },
  );
  const token = `${header}.${payload}.${base64url(signature)}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();
function session(env: ApnsEnv): http2.ClientHttp2Session {
  const live = sessions.get(env);
  if (live && !live.closed && !live.destroyed) return live;
  const next = http2.connect(HOSTS[env]);
  next.on("error", (err) => {
    console.warn(`[apns] соединение (${env}) оборвалось:`, err.message);
    sessions.delete(env);
  });
  sessions.set(env, next);
  return next;
}

type ApnsResult = { status: number; reason?: string };

function post(env: ApnsEnv, token: string, body: unknown): Promise<ApnsResult> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = session(env).request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": TOPIC,
      "apns-push-type": "liveactivity",
      // 10 — «доставить немедленно». Для живой карточки прогресса это и нужно;
      // Apple разрешает такой приоритет именно для liveactivity.
      "apns-priority": "10",
      "apns-expiration": "0",
      authorization: `bearer ${providerToken()}`,
      "content-type": "application/json",
      "content-length": payload.length,
    });

    let status = 0;
    let raw = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("error", (err) => resolve({ status: 0, reason: err.message }));
    req.on("end", () => {
      let reason: string | undefined;
      try {
        reason = raw ? JSON.parse(raw).reason : undefined;
      } catch {
        reason = raw || undefined;
      }
      resolve({ status, reason });
    });
    req.end(payload);
  });
}

// Каким адресом Apple отвечает на наши токены. Сборка с Мака подписана
// development-профилем и живёт в песочнице, но стоит перейти на TestFlight —
// и тот же код обязан ходить в боевой. Вместо ручного переключателя пробуем
// один, при отказе «не тот токен» — другой, и запоминаем удачный.
const configuredEnv = (process.env.APNS_ENV || "auto") as ApnsEnv | "auto";
let currentEnv: ApnsEnv = configuredEnv === "prod" ? "prod" : "sandbox";

async function send(token: string, body: unknown): Promise<ApnsResult> {
  const first = await post(currentEnv, token, body);
  if (configuredEnv !== "auto" || first.reason !== "BadDeviceToken")
    return first;

  const other: ApnsEnv = currentEnv === "sandbox" ? "prod" : "sandbox";
  const second = await post(other, token, body);
  if (second.status === 200) {
    console.log(`[apns] переключился на ${other}`);
    currentEnv = other;
  }
  return second;
}

// Те же имена картинок, что знает приложение (src/lib/liveActivity.ts).
// Расходиться им нельзя: пуш перезаписывает карточку целиком, и незнакомое
// имя означает, что вместо картинки внезапно появится буква.
const AVATAR_SLUGS: Record<string, string> = {
  Максим: "maksim",
  Claude_Bot: "claude",
  Hermes: "hermes",
  "DeepSeek-Agent": "deepseek",
  Antigravity: "antigravity",
  // Восемь канонических ролей (14.09.2026). Картинки лежат в ассетах
  // расширения на маке (ios/App/TaskFlowWidgets/Assets.xcassets) — отсюда
  // только имена; пока нет файла — iOS отрисует букву, без поломки.
  Исследователь: "researcher",
  Аналитик: "analyst",
  "Критик-проверяющий": "critic_verifier",
  Архитектор: "architect",
  Разработчик: "builder",
  QA: "qa",
  "Дизайнер интерфейсов": "designer",
};

/** Строка content-state ровно по полям TaskActivityAttributes.ContentState:
 *  разойдутся имена — устройство молча отбросит обновление. */
function contentState(task: any, startedAt?: string | null) {
  const subtasks: any[] = task.subtasks || [];
  const total = subtasks.length;
  const done = subtasks.filter((s) => s.done).length;
  const running = subtasks.find((s) => s.state === "running");
  const pending = subtasks.find((s) => !s.done);
  const completed = task.status === "completed";

  const statusLabel = completed
    ? "Выполнена"
    : task.agent_state === "review"
      ? "На проверке"
      : task.agent_state === "blocked"
        ? "Заблокирована"
        : task.agent_state === "in_progress"
          ? "В работе"
          : "Активна";

  return {
    status: task.agent_state || (completed ? "completed" : "in_progress"),
    statusLabel,
    currentSubtask: (running || pending)?.title ?? null,
    totalSubtasks: total,
    doneSubtasks: done,
    progress: total > 0 ? done / total : completed ? 1 : 0,
    assigneeName: task.assignee_name || "Агент",
    assigneeInitials: task.assignee_initials || "А",
    assigneeColor: task.assignee_color || "#3A82F6",
    taskTitle: task.title || "Задача",
    projectName: task.project_name ?? null,
    projectColor: task.project_color ?? null,
    updatedAt: Math.floor(Date.now() / 1000) - APPLE_EPOCH_OFFSET,
    assigneeSlug: (task.assignee_name && AVATAR_SLUGS[task.assignee_name]) ?? null,
    // Дата в тех же секундах от 2001 года, что и updatedAt: с этого момента
    // островок сам крутит счётчик времени работы.
    startedAt: startedAt
      ? Math.floor(new Date(startedAt + "Z").getTime() / 1000) - APPLE_EPOCH_OFFSET
      : Math.floor(Date.now() / 1000) - APPLE_EPOCH_OFFSET,
  };
}

function tokenFor(taskId: string): string | null {
  const row = db
    .prepare("SELECT token FROM live_activity_tokens WHERE task_id = ?")
    .get(taskId) as any;
  return row?.token || null;
}

function startedAtFor(taskId: string): string | null {
  const row = db
    .prepare("SELECT started_at FROM live_activity_tokens WHERE task_id = ?")
    .get(taskId) as any;
  return row?.started_at || null;
}

function forgetToken(taskId: string) {
  db.prepare("DELETE FROM live_activity_tokens WHERE task_id = ?").run(taskId);
}

async function push(task: any, event: "update" | "end") {
  const token = tokenFor(task.id);
  if (!token) return;

  const now = Math.floor(Date.now() / 1000);
  const aps: Record<string, unknown> = {
    timestamp: now,
    event,
    // Время работы считается от взятия задачи агентом (agent_started_at из
    // журнала). Задачу вывели в островок руками — журнала нет, тогда точка
    // отсчёта та, что записана вместе с токеном.
    "content-state": contentState(task, task.agent_started_at || startedAtFor(task.id)),
  };
  if (event === "update") {
    // До этого момента данные считаются свежими. Пуши идут чаще, каждый
    // отодвигает границу; замолчал сервер — карточка гаснет по смыслу, а не
    // висит враньём.
    aps["stale-date"] = now + 15 * 60;
  } else {
    // Итог задачи ещё пару минут виден на экране блокировки, потом карточка
    // уходит сама.
    aps["dismissal-date"] = now + 120;
  }

  const res = await send(token, { aps });
  if (res.status === 200) return;

  // 410 и эти две причины означают одно: активности на устройстве больше нет
  // (погашена, смахнута, приложение переустановлено). Строку убираем, иначе
  // будем стучаться в неё до скончания века.
  if (
    res.status === 410 ||
    res.reason === "BadDeviceToken" ||
    res.reason === "Unregistered" ||
    res.reason === "ExpiredToken"
  ) {
    forgetToken(task.id);
    return;
  }
  console.warn(
    `[apns] обновление задачи ${task.id} не доставлено: ${res.status} ${res.reason || ""}`,
  );
}

// Событий по одной задаче прилетает пачками: агент закрыл шаг — это и правка
// задачи, и правка подзадачи, и запись в журнал. Отправлять на каждое
// движение и дорого, и незачем — Apple ограничивает частоту обновлений
// активности. Склеиваем всё, что случилось за секунду, в один пуш.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 1000;

/** Единственная точка входа: сюда попадает задача из ws.ts на каждое
 *  событие task:*. Задача уже гидратирована — второй раз в базу не ходим. */
export function queueLiveActivityPush(task: any) {
  if (!apnsConfigured || !task?.id) return;
  if (!tokenFor(task.id)) return;

  const existing = pending.get(task.id);
  if (existing) clearTimeout(existing);
  pending.set(
    task.id,
    setTimeout(() => {
      pending.delete(task.id);
      const event = task.status === "completed" ? "end" : "update";
      void push(task, event).catch((err) =>
        console.warn("[apns] сбой отправки:", err?.message || err),
      );
    }, DEBOUNCE_MS),
  );
}
