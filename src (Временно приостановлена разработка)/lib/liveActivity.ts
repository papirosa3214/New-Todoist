// src/lib/liveActivity.ts
// Мост между веб-приложением и нативным ActivityKit (Dynamic Island).

import { Capacitor, registerPlugin } from "@capacitor/core";
import { api } from "../api/client";
import type { ApiTask } from "../api/types";

interface LiveActivityPluginType {
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>;
  startTaskActivity(options: {
    taskId: string;
    taskTitle: string;
    assigneeName?: string;
    assigneeInitials?: string;
    assigneeColor?: string;
    assigneeSlug?: string;
    projectName?: string;
    projectColor?: string;
    totalSubtasks?: number;
    doneSubtasks?: number;
    currentSubtask?: string;
    status?: string;
    statusLabel?: string;
    progress?: number;
    /** Секунды Unix момента, с которого островок считает время работы. */
    startedAtUnix?: number;
  }): Promise<{ id: string; taskId: string; started: boolean }>;
  updateTaskActivity(options: {
    taskId: string;
    taskTitle?: string;
    assigneeName?: string;
    assigneeColor?: string;
    assigneeSlug?: string;
    projectName?: string;
    projectColor?: string;
    totalSubtasks?: number;
    doneSubtasks?: number;
    currentSubtask?: string;
    status?: string;
    statusLabel?: string;
    progress?: number;
  }): Promise<{ updated: boolean }>;
  endTaskActivity(options?: { taskId?: string }): Promise<{ ended: boolean }>;
  listActivities(): Promise<{ activities: any[] }>;
  addListener(
    eventName: "activityPushToken",
    listener: (data: { taskId: string; token: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const LiveActivity = registerPlugin<LiveActivityPluginType>("LiveActivity");

const NATIVE = Capacitor.isNativePlatform();
// Островок существует только в нативной сборке под iOS 16.1+. В браузере
// registerPlugin вернёт веб-заглушку, у которой этих методов нет: каждый вызов
// уйдёт в reject, и без этой проверки консоль забьётся мусором на каждом
// открытии задачи.
//
// isPluginAvailable проверяет РЕАЛЬНУЮ регистрацию на нативной стороне, а не
// имя в реестре JS — имя туда кладёт сам registerPlugin, поэтому по нему
// отличить живой плагин от отсутствующего нельзя. Ровно на этом островок
// молча не работал: Swift-файл был написан и собран, но строку
// registerPluginInstance в capacitorDidLoad не добавили (LocalAIPlugin.swift).
const HAS_PLUGIN = NATIVE && Capacitor.isPluginAvailable("LiveActivity");

if (NATIVE) {
  console.log(
    `[liveActivity] нативный плагин: ${HAS_PLUGIN ? "есть" : "НЕ ЗАРЕГИСТРИРОВАН"}`,
  );
}

// Задача, которую владелец вывел в островок руками (кнопка в шапке карточки).
// Ручной выбор старше автоматики: пока эта задача жива, автозапуск по работе
// агента её не перебивает — иначе человек вывел одно, а через десять секунд
// увидел другое. Держим в памяти модуля, а не в состоянии экрана: экран
// закрывается, островок остаётся.
let manualTaskId: string | null = null;

// Кнопку «вывести в островок» нажимают на экране задачи, а раскладывает
// карточки хук в Layout — и узнаёт он о нажатии только из этой подписки.
// Без неё ручной выбор доезжал бы до островка лишь со следующим обновлением
// доски: обычно через секунды, но на тихой доске — когда угодно.
const manualListeners = new Set<() => void>();

export function setManualIslandTask(taskId: string | null): void {
  if (manualTaskId === taskId) return;
  manualTaskId = taskId;
  for (const notify of manualListeners) notify();
}

export function subscribeManualIslandTask(listener: () => void): () => void {
  manualListeners.add(listener);
  return () => {
    manualListeners.delete(listener);
  };
}

export function getManualIslandTask(): string | null {
  return manualTaskId;
}

/** Отдать серверу токен активности: по нему APNs доставляет обновления, пока
 *  приложение свёрнуто. Токен выдаёт система, не мы, и он меняется — поэтому
 *  шлём каждый новый, а сервер хранит последний на задачу.
 *
 *  Подписка ставится один раз на всё приложение: событий мало, а снимать её
 *  некому — плагин живёт столько же, сколько само приложение. */
let pushBridgeStarted = false;
export function startActivityPushTokenBridge(): void {
  if (!HAS_PLUGIN || pushBridgeStarted) return;
  pushBridgeStarted = true;
  void LiveActivity.addListener("activityPushToken", ({ taskId, token }) => {
    void api
      .post("/api/live-activity/token", { taskId, token })
      .catch((err) =>
        console.warn("[liveActivity] токен не принят сервером:", err),
      );
  }).catch((err) =>
    console.warn("[liveActivity] не удалось подписаться на токен:", err),
  );
}

/** Итог попытки: показать его человеку, а не проглотить. */
export type LiveActivityResult =
  | { ok: true; action: "started" | "updated" | "ended" | "skipped" }
  | { ok: false; reason: string };

export async function isLiveActivityAvailable(): Promise<boolean> {
  if (!HAS_PLUGIN) return false;
  try {
    const res = await LiveActivity.isAvailable();
    return res.available && res.enabled;
  } catch {
    return false;
  }
}

function getStatusLabel(task: ApiTask): string {
  if (task.status === "completed") return "Выполнена";
  if (task.agent_state === "review") return "На проверке";
  if (task.agent_state === "blocked") return "Заблокирована";
  if (task.agent_state === "in_progress") return "В работе";
  return "Активна";
}

function getAssigneeName(task: ApiTask): string {
  return task.assignee_name || "Агент";
}

// Имя картинки в ассетах расширения (ios/App/TaskFlowWidgets/Assets.xcassets).
// Сети у островка нет — картинки лежат в нём самом, а отсюда приходит только
// имя. Кого тут нет — покажется буквой, как раньше.
const AVATAR_SLUGS: Record<string, string> = {
  Максим: "maksim",
  Claude_Bot: "claude",
  Hermes: "hermes",
  "DeepSeek-Agent": "deepseek",
  Antigravity: "antigravity",
  // Восемь канонических ролей (14.09.2026).
  // Изображения добавятся на стороне мака (Assets.xcassets).
  Исследователь: "researcher",
  Аналитик: "analyst",
  "Критик-проверяющий": "critic_verifier",
  Архитектор: "architect",
  Разработчик: "builder",
  QA: "qa",
  "Дизайнер интерфейсов": "designer",
};

function getAssigneeSlug(task: ApiTask): string | undefined {
  return task.assignee_name ? AVATAR_SLUGS[task.assignee_name] : undefined;
}

/** С какого момента островок считает время работы: когда агент взял задачу.
 *  Нет такой отметки (задачу вывели руками) — с этой секунды. */
function getStartedAtUnix(task: ApiTask): number {
  const raw = task.agent_started_at;
  if (raw) {
    // Сервер отдаёт время журнала в UTC без пометки часового пояса.
    const ms = Date.parse(raw.includes("Z") ? raw : `${raw.replace(" ", "T")}Z`);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export async function syncTaskToLiveActivity(
  task: ApiTask,
  opts: { force?: boolean; currentSubtaskTitle?: string } = {},
): Promise<LiveActivityResult> {
  if (!HAS_PLUGIN) {
    return {
      ok: false,
      reason: NATIVE
        ? "Плагин Live Activity не подключён в этой сборке"
        : "Островок работает только в приложении на iPhone",
    };
  }

  try {
    const totalSub = task.subtasks.length;
    const doneSub = task.subtasks.filter((s) => s.done).length;
    const activeSub =
      opts.currentSubtaskTitle ||
      task.subtasks.find((s) => s.state === "running")?.title ||
      task.subtasks.find((s) => !s.done)?.title ||
      undefined;

    const progress =
      totalSub > 0 ? doneSub / totalSub : task.status === "completed" ? 1.0 : 0.0;
    const status =
      task.agent_state || (task.status === "completed" ? "completed" : "in_progress");
    const statusLabel = getStatusLabel(task);

    // Задача закрыта — активности больше не место на экране.
    if (task.status === "completed") {
      await LiveActivity.endTaskActivity({ taskId: task.id });
      return { ok: true, action: "ended" };
    }

    // Сначала пробуем обновить: плагин сам ответит updated:false, если
    // активности для этой задачи нет.
    const updateRes = await LiveActivity.updateTaskActivity({
      taskId: task.id,
      taskTitle: task.title,
      assigneeName: getAssigneeName(task),
      assigneeSlug: getAssigneeSlug(task),
      assigneeColor: task.assignee_color || "#3A82F6",
      projectName: task.project_name || undefined,
      projectColor: task.project_color || undefined,
      totalSubtasks: totalSub,
      doneSubtasks: doneSub,
      currentSubtask: activeSub,
      status,
      statusLabel,
      progress,
    });

    if (updateRes.updated) return { ok: true, action: "updated" };

    // Активности не было. Заводить её по каждому касанию задачи нельзя —
    // островок не свалка: сам собой он загорается только когда по задаче
    // действительно идёт работа. Кнопка в шапке задачи передаёт force и
    // выводит любую задачу принудительно.
    if (!opts.force && task.agent_state !== "in_progress") {
      return { ok: true, action: "skipped" };
    }

    await LiveActivity.startTaskActivity({
      taskId: task.id,
      taskTitle: task.title,
      assigneeName: getAssigneeName(task),
      assigneeInitials: task.assignee_initials || "А",
      assigneeSlug: getAssigneeSlug(task),
      assigneeColor: task.assignee_color || "#3A82F6",
      projectName: task.project_name || undefined,
      projectColor: task.project_color || undefined,
      totalSubtasks: totalSub,
      doneSubtasks: doneSub,
      currentSubtask: activeSub,
      status,
      statusLabel,
      progress,
      startedAtUnix: getStartedAtUnix(task),
    });
    return { ok: true, action: "started" };
  } catch (err: any) {
    // Причину не глотаем: раньше здесь стоял console.debug, а кнопка всё
    // равно рапортовала успехом — отказ был неотличим от работы.
    const reason = err?.message || String(err);
    console.warn("[liveActivity] не удалось синхронизировать:", reason);
    return { ok: false, reason };
  }
}

/** Погасить всё, что осталось с прошлого запуска приложения.
 *
 *  Активность живёт дольше приложения: перезапустили — она осталась висеть, а
 *  хук про неё уже не помнит и гасить её некому. Поймано на живой проверке
 *  24.08.2026: карточка тестовой задачи осталась в островке после того, как
 *  приложение перезапустили. Спрашиваем систему, что вообще сейчас показано,
 *  и оставляем только те задачи, что показываем сейчас сами.
 *
 *  keep — одна задача или несколько: карточек теперь до трёх, и оставить
 *  надо всю тройку, а не первую попавшуюся. */
export async function endStaleActivities(
  keep?: string | string[],
): Promise<void> {
  if (!HAS_PLUGIN) return;
  const keepIds = new Set(
    keep === undefined ? [] : Array.isArray(keep) ? keep : [keep],
  );
  try {
    const { activities } = await LiveActivity.listActivities();
    for (const act of activities || []) {
      if (act?.taskId && !keepIds.has(act.taskId)) {
        await stopTaskLiveActivity(act.taskId);
      }
    }
  } catch (err) {
    console.warn("[liveActivity] не удалось прибрать старые карточки:", err);
  }
}

export async function stopTaskLiveActivity(taskId?: string): Promise<void> {
  if (!HAS_PLUGIN) return;
  try {
    await LiveActivity.endTaskActivity({ taskId });
  } catch (err) {
    console.warn("[liveActivity] не удалось погасить:", err);
  }
  // Токен погашенной карточки живёт на сервере до тех пор, пока Apple не
  // ответит отказом «такой активности нет», — а до того сервер исправно шлёт
  // в неё пуши. Пока карточка была одна, это был один холостой пуш; теперь их
  // до трёх, и мусор копится втрое быстрее. Снимаем токен сразу.
  if (!taskId) return;
  try {
    await api.delete(`/api/live-activity/token/${taskId}`);
  } catch (err) {
    console.warn("[liveActivity] токен не снят на сервере:", err);
  }
}
