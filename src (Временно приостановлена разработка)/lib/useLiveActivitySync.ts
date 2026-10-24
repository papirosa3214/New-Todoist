// Автоматический островок: пока агенты работают над задачами, их прогресс сам
// висит на экране блокировки и в Dynamic Island — без нажатия кнопки в шапке
// задачи.
//
// Почему хук здесь, а не в TaskDetailScreen: островок должен жить, даже когда
// экрана задачи на виду нет — Максим уходит в другой раздел или сворачивает
// приложение. Поэтому хук монтируется один раз в Layout, рядом с
// useNotificationsSocket, и работает от того же списка задач, что и вся доска:
// сокет инвалидирует кэш ["tasks"], useTasks отдаёт свежие данные, хук
// перекладывает их в активности.
//
// ВАЖНО про фон. Пока приложение свёрнуто, JS не выполняется, и этот хук
// молчит — обновления в фоне приходят пушем от сервера (ActivityKit push,
// см. server/src/apns.ts). Хук отвечает за то, что видно на переднем плане и
// за сам факт запуска активности: стартовать её может только приложение.
//
// СКОЛЬКО КАРТОЧЕК. Работа часто идёт по нескольким задачам сразу, и раньше
// островок доставался одной — самой свежей. Теперь их до трёх, по карточке на
// задачу: экран блокировки показывает все три отдельными плашками, а Dynamic
// Island — две из них (одна у выреза камеры, вторая кружком справа,
// переключение тапом). Больше трёх не заводим: заблокированный экран
// превращается в ленту, а в островок всё равно попадают только две.

import { useEffect, useRef, useState } from "react";
import { useTasks } from "../api/tasks";
import type { ApiTask } from "../api/types";
import {
  endStaleActivities,
  getManualIslandTask,
  setManualIslandTask,
  startActivityPushTokenBridge,
  stopTaskLiveActivity,
  subscribeManualIslandTask,
  syncTaskToLiveActivity,
} from "./liveActivity";

const MAX_ACTIVITIES = 3;

// Сколько держать карточку после того, как работа по задаче закончилась. iOS
// сама гасит активность по своему таймауту, но нам нужно, чтобы итог («На
// проверке», «Заблокирована») успел попасться на глаза, а не исчез в тот же
// миг.
const LINGER_MS = 30_000;

function isWorking(t: ApiTask): boolean {
  return t.status !== "completed" && t.agent_state === "in_progress";
}

function freshness(t: ApiTask): string {
  return t.agent_heartbeat_at || t.updated_at || "";
}

/** Какие задачи показываем прямо сейчас. Экспортируется ради теста
 *  (`useLiveActivitySync.test.ts`): это единственная часть островка, которую
 *  можно проверить без телефона.
 *
 *  Порядок отбора важнее самой сортировки. Сначала ручной выбор владельца:
 *  вывел задачу кнопкой — она в тройке, чем бы ни занимались агенты. Потом те,
 *  что УЖЕ показаны и всё ещё в работе: карточка не должна исчезать только
 *  потому, что у соседней задачи сигнал агента пришёл на секунду позже —
 *  иначе при четырёх работающих задачах плашки мигали бы по кругу. И лишь
 *  свободные места достаются новым задачам, самым свежим по сигналу. */
export function pickTargets(
  tasks: ApiTask[],
  manualId: string | null,
  shown: string[],
): ApiTask[] {
  const working = tasks
    .filter(isWorking)
    .sort(
      (a, b) =>
        freshness(b).localeCompare(freshness(a)) || a.id.localeCompare(b.id),
    );

  const picked: ApiTask[] = [];
  const add = (t: ApiTask | undefined) => {
    if (!t || picked.length >= MAX_ACTIVITIES) return;
    if (picked.some((p) => p.id === t.id)) return;
    picked.push(t);
  };

  const manual = manualId ? tasks.find((t) => t.id === manualId) : undefined;
  if (manual && manual.status !== "completed") add(manual);
  for (const id of shown) add(working.find((t) => t.id === id));
  for (const t of working) add(t);

  return picked;
}

export function useLiveActivitySync(enabled: boolean) {
  const { data: tasks } = useTasks();
  // Какие задачи сейчас показывает система. Нужен, чтобы гасить карточки
  // выбывших задач — иначе на экране блокировки копится по плашке от каждой
  // задачи, что успела побывать в работе.
  const shown = useRef<string[]>([]);
  // Отложенное гашение — своё на каждую задачу: работа по ним заканчивается
  // вразнобой, и один общий таймер гасил бы не ту карточку.
  const lingering = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Токен активности выдаёт система отдельным потоком, а не ответом на
  // запуск, — подписку на него ставим один раз при входе в приложение.
  useEffect(() => {
    if (enabled) startActivityPushTokenBridge();
  }, [enabled]);

  // Кнопку «вывести в островок» нажимают на экране задачи; список задач при
  // этом не меняется, и без подписки пересборка карточек ждала бы следующего
  // обновления доски.
  const [manualTick, setManualTick] = useState(0);
  useEffect(
    () => subscribeManualIslandTask(() => setManualTick((n) => n + 1)),
    [],
  );

  // Первый проход после запуска приложения: активности могли пережить его
  // перезапуск, и тогда висят карточки задач, работа по которым давно
  // кончилась. Гасим всё лишнее — кроме тех, что показываем сейчас.
  const cleanedUp = useRef(false);

  useEffect(() => {
    if (!enabled || !tasks) return;

    const cancelLinger = (id: string) => {
      const timer = lingering.current.get(id);
      if (timer) {
        clearTimeout(timer);
        lingering.current.delete(id);
      }
    };

    // Ручной выбор владельца главнее автоматики — но только пока задача жива
    // и не закрыта. Закрылась или исчезла — отпускаем и возвращаемся к тому,
    // над чем работают агенты.
    const manualId = getManualIslandTask();
    const manual = manualId ? tasks.find((t) => t.id === manualId) : undefined;
    if (manualId && (!manual || manual.status === "completed")) {
      setManualIslandTask(null);
    }
    const activeManualId =
      manual && manual.status !== "completed" ? manualId : null;

    const targets = pickTargets(tasks, activeManualId, shown.current);
    const targetIds = targets.map((t) => t.id);

    if (!cleanedUp.current) {
      cleanedUp.current = true;
      void endStaleActivities(targetIds);
    }

    // Выбывшие карточки.
    for (const id of shown.current) {
      if (targetIds.includes(id)) continue;
      const left = tasks.find((t) => t.id === id);

      // Задачи больше нет в списке (удалена, ушла из видимости) — показывать
      // нечего, гасим сразу.
      if (!left) {
        cancelLinger(id);
        void stopTaskLiveActivity(id);
        continue;
      }

      // Задача всё ещё в работе, но её вытеснила более свежая: мест только
      // три. Итога у неё нет, задерживать карточку не за чем.
      if (isWorking(left)) {
        cancelLinger(id);
        void stopTaskLiveActivity(id);
        continue;
      }

      // Работа закончилась. Последний раз обновляем карточку (чтобы вместо «В
      // работе» стало «На проверке»/«Заблокирована»), а гасим с задержкой.
      void syncTaskToLiveActivity(left);
      if (!lingering.current.has(id)) {
        lingering.current.set(
          id,
          setTimeout(() => {
            lingering.current.delete(id);
            void stopTaskLiveActivity(id);
          }, LINGER_MS),
        );
      }
    }

    // Живые карточки: заводим новые, обновляем уже показанные.
    for (const t of targets) {
      cancelLinger(t.id);
      void syncTaskToLiveActivity(t, { force: t.id === activeManualId });
    }

    shown.current = targetIds;
  }, [enabled, tasks, manualTick]);

  // Размонтирование Layout = выход из аккаунта. Активности после этого
  // показывать нечего и некому.
  useEffect(() => {
    const timers = lingering.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      // Список читаем в момент размонтирования, а не при подписке: на входе он
      // пуст, и захваченная копия погасила бы ровно ничего.
      for (const id of shown.current) void stopTaskLiveActivity(id);
    };
  }, []);
}
