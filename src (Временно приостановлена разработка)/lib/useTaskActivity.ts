// Живая строка «чем агент занят сейчас» в карточке задачи — данные из
// отдельного канала server/src/routes/activity.ts, мимо react-query (см.
// комментарий над onTaskActivity в api/ws.ts). Один экземпляр состояния на
// открытую карточку: начальный GET подхватывает то, что сервер уже накопил
// (карточку могли открыть посреди работы агента), дальше строку двигает
// только WS.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { onTaskActivity, type TaskActivityEvent } from "../api/ws";
import { explainAction } from "./localLLM";
import { LocalNotifications } from "@capacitor/local-notifications";

/** Пауза между вызовами модели. Было 10 с «бережём батарею», но модель
 *  зовётся только при ОТКРЫТОЙ карточке (см. active) — Максим 26.08.2026:
 *  раз я и так смотрю, пусть объясняет живее. */
export const EXPLAIN_EVERY_MS = 5_000;

/**
 * Звать ли модель на это событие.
 *
 * Только на правки и только когда сервер прислал сам кусок изменения: по
 * «читает файл» объяснять нечего, а без диффа модели не с чем работать —
 * она начнёт выдумывать по имени файла, и это будет ХУЖЕ честной строки от
 * сервера.
 */
/** Что функция реально читает из события — kind/diff (для правок) и
 *  text (опционально: только для распознавания state-change по словам
 *  «review/blocked/...»; правки без text идут по kind/diff ветке).
 *  Полный TaskActivityEvent строже, чем нужно: тесты гоняют shouldExplain
 *  на минимальных {kind, diff}, без task_id/actor_name/at/text, которые
 *  для логики «звать ли модель» не нужны. */
interface ShouldExplainEvent {
  kind?: TaskActivityEvent["kind"];
  diff?: TaskActivityEvent["diff"];
  text?: TaskActivityEvent["text"];
}

export function shouldExplain(
  event: ShouldExplainEvent,
  lastAt: number,
  now: number,
): boolean {
  // text опционален — функция дёргается и на минимальных событиях без
  // строки (правки приходят только с kind/diff), и на полных, где есть
  // строка для распознавания state-change по словам.
  const text = event.text ?? "";
  const isStateChange =
    text.includes("review") ||
    text.includes("blocked") ||
    text.toLowerCase().includes("проверк") ||
    text.toLowerCase().includes("ошибк") ||
    text.toLowerCase().includes("заблокирован");

  if (!isStateChange) {
    if (event.kind !== "edit") return false;
    if (!event.diff || event.diff.trim().length < 10) return false;
    if (now - lastAt < EXPLAIN_EVERY_MS) return false;
  }

  return true;
}

/** Что скармливаем модели: действие плюс сам кусок правки. */
export function explainInput(event: { text: string; diff?: string }): string {
  const doing = actionOf(event.text);
  return event.diff ? `${doing}\n${event.diff}` : doing;
}

/** Сервер склеивает строку как «шаг · действие» — разбираем обратно. */
export function stepOf(text: string): string | undefined {
  const i = text.indexOf(" · ");
  return i > 0 ? text.slice(0, i) : undefined;
}

export function actionOf(text: string): string {
  const i = text.indexOf(" · ");
  return i > 0 ? text.slice(i + 3) : text;
}

/**
 * Подставляем фразу модели вместо действия, СОХРАНЯЯ название шага: шаг —
 * факт с сервера, его модель заменять не должна.
 */
export function mergeExplained(serverText: string, phrase: string): string {
  const step = stepOf(serverText);
  return step ? `${step} · ${phrase}` : phrase;
}

export interface ActivityAction {
  kind: "read" | "edit" | "search" | "run";
  target: string;
  detail?: string;
  actor: string;
  at: number;
  /** Готовая формулировка от сервера (describeAction в routes/activity.ts):
   *  «разбирается в src/lib/search.ts». Показывать надо её, а не target —
   *  иначе список читается как выписка из лога вызовов. */
  text?: string;
}

export interface TaskActivityState {
  text: string | null;
  actorName: string | null;
  at: number | null;
}

const EMPTY: TaskActivityState = { text: null, actorName: null, at: null };

/**
 * @param active Есть ли сейчас смысл слушать — карточка уже знает через
 *   agent_state/agent_stale, идёт ли работа. Сервер сам гасит буфер, когда
 *   задача не в работе (activity.ts), но пока задача уходит из in_progress
 *   локально WS-событие об этом не приходит — поэтому клиент гасит строку
 *   сам, тем же условием, что уже красит статус-плашку.
 */
export function useTaskActivity(
  taskId: string | undefined,
  active: boolean,
): TaskActivityState {
  const [state, setState] = useState<TaskActivityState>(EMPTY);
  // Когда в последний раз звали модель. Она живёт на телефоне, каждый вызов
  // — работа процессора и батарея, поэтому раз в EXPLAIN_EVERY_MS, а не на
  // каждое действие агента.
  const lastExplainAt = useRef(0);

  useEffect(() => {
    if (!taskId || !active) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const readBuffer = () => {
      api
        .get<{ text: string | null; actions: ActivityAction[] }>(
          `/api/tasks/${taskId}/activity`,
        )
        .then((r) => {
          if (cancelled || !r.text) return;
          const last = r.actions[r.actions.length - 1];
          setState((prev) => {
            // WS мог уже принести строку свежее буфера — не откатываем её.
            if (prev.at && last?.at && last.at <= prev.at) return prev;
            return {
              text: r.text,
              actorName: last?.actor ?? null,
              at: last?.at ?? null,
            };
          });
        })
        .catch(() => {
          // Карточка просто останется без строки — следующее действие
          // агента (если есть) придёт по WS и заполнит её.
        });
    };

    // Первый GET подхватывает уже накопленное, а повторный раз в 15 с —
    // это ещё и «пульс смотрящего»: сервер по нему понимает, что карточка
    // открыта, и только для таких задач зовёт Ollama-наблюдателя
    // (activity.ts, lastWatchedAt). Просьба Максима 26.08.2026 — модель
    // не должна крутиться фоном для задач, на которые никто не смотрит.
    readBuffer();
    const heartbeat = setInterval(readBuffer, 15_000);

    const unsubscribe = onTaskActivity((event: TaskActivityEvent) => {
      if (event.task_id !== taskId) return;
      // Сначала — строка от сервера, всегда и сразу. Модель может ответить
      // через секунду, а может не ответить вовсе (не скачана, занята,
      // ошиблась) — строка не должна этого ждать.
      setState({ text: event.text, actorName: event.actor_name, at: event.at });

      if (!shouldExplain(event, lastExplainAt.current, Date.now())) return;
      lastExplainAt.current = Date.now();
      void explainAction(explainInput(event), stepOf(event.text)).then((phrase) => {
        if (cancelled || !phrase) return;

        let cleanPhrase = phrase;
        const notifyMatch = cleanPhrase.match(/\[NOTIFY:\s*(.+?)\]/);
        if (notifyMatch) {
          const notifyMessage = notifyMatch[1];
          cleanPhrase = cleanPhrase.replace(notifyMatch[0], '').trim();
          void LocalNotifications.requestPermissions().then((perm) => {
            if (perm.display === 'granted') {
              void LocalNotifications.schedule({
                notifications: [{
                  title: "TaskFlow: Внимание",
                  body: notifyMessage,
                  id: Date.now(),
                }]
              });
            }
          });
        }

        if (!cleanPhrase) return;

        setState((prev) =>
          prev.at === event.at
            ? { ...prev, text: mergeExplained(event.text, cleanPhrase) }
            : prev,
        );
      });
    });

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
  }, [taskId, active]);

  return state;
}

/** Последние действия задачи — только по требованию (тап на строку). */
export async function fetchRecentActivity(
  taskId: string,
): Promise<ActivityAction[]> {
  const r = await api.get<{ text: string | null; actions: ActivityAction[] }>(
    `/api/tasks/${taskId}/activity`,
  );
  return r.actions;
}
