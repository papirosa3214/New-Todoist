import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, getToken } from "./client";

export interface TaskActivityEvent {
  type: "task:activity";
  task_id: string;
  text: string;
  actor_name: string;
  session_id: string | null;
  at: number;
  /** Кусок правки и сырые поля действия — материал для модели на телефоне
   *  (lib/localLLM.ts). Едут вместе со строкой, чтобы не ходить за ними
   *  отдельным запросом на каждое действие агента. */
  diff?: string;
  kind?:
    | "read"
    | "edit"
    | "write"
    | "search"
    | "run"
    | "think"
    | "web"
    | "image"
    | "test"
    | "build"
    | "git"
    | "attach";
  target?: string;
}

type ActivityListener = (event: TaskActivityEvent) => void;

// Живая строка «чем занят агент» (server/src/routes/activity.ts) идёт по
// тому же сокету, что и всё остальное, но НЕ через react-query: событий
// task:activity — раз в ~2 секунды на активную задачу, а invalidateQueries
// на каждое из них устроило бы карточке шквал перезапросов (план
// ~/traycer-artifacts/agent-live-activity/index.md, «подводный камень на
// клиенте»). Поэтому свой мини pub/sub мимо кэша: подписчик (карточка
// задачи) сам решает, что делать со строкой, в локальном state.
const activityListeners = new Set<ActivityListener>();

export function onTaskActivity(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export interface ChatMessageEvent {
  type: "chat:new";
  message: {
    id: string;
    from_user_id: string;
    to_user_id: string | null;
    task_id: string | null;
    kind: string | null;
    text: string;
    created_at: string;
    [key: string]: unknown;
  };
}

type ChatListener = (event: ChatMessageEvent) => void;

// Чат агентов (27-28.08.2026, задача «Чат агентов в TaskFlow»): по тому же
// образцу, что task:activity выше — сообщение идёт в каждый открытый сокет
// (общий канал, не только адресату), а общая invalidateQueries тут не нужна
// вовсе: до появления src/api/chat.ts кэша "chat" ещё нет, а когда появится —
// экран чата сам решит, дописать строку в локальный state или перечитать
// страницу, а не дёргать кэш задач/проектов на каждую реплику координации.
const chatListeners = new Set<ChatListener>();

export function onChatMessage(listener: ChatListener): () => void {
  chatListeners.add(listener);
  return () => chatListeners.delete(listener);
}

export interface ChatTypingEvent {
  type: "chat:typing";
  user_id: string;
  name: string;
  state: "typing" | "stop";
  /** Через сколько отметку гасить, если подтверждения не будет. Срок
   *  относительный: часы телефона и сервера расходятся, абсолютная метка
   *  гасила бы отметку раньше времени. */
  ttl_ms: number;
}

type ChatTypingListener = (event: ChatTypingEvent) => void;

// «Печатает…» — отдельная ветка по той же причине, что task:activity и
// chat:new: это состояние «прямо сейчас», а не данные. Одна общая
// invalidateQueries на каждое нажатие клавиши собеседника перезапрашивала
// бы задачи и проекты — ровно тот шквал, от которого уходили выше.
const chatTypingListeners = new Set<ChatTypingListener>();

export function onChatTyping(listener: ChatTypingListener): () => void {
  chatTypingListeners.add(listener);
  return () => chatTypingListeners.delete(listener);
}

// Live updates over /ws.
//
// Auth: the socket is authenticated via a `?token=` query param (JWT or
// api_token), NOT an Authorization header (sockets can't set one) — the
// server resolves userId from that token itself, a client can't subscribe
// to someone else's stream. See AGENT-API.md §5 for the full event list
// (task:created/updated/completed/deleted, notification:new); this hook
// doesn't special-case each one, it just invalidates the two query caches
// that cover all of them. task:activity is the one exception — see
// onTaskActivity above.
export function useNotificationsSocket(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token) return;
    const httpBase = API_BASE_URL || window.location.origin;
    const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

    let socket: WebSocket | null = null;
    let pingInterval: any = null;
    let reconnectTimeout: any = null;
    let isDisposed = false;
    // Когда в последний раз ЧТО-ЛИБО пришло от сервера (pong считается).
    // Нужен для сторожа ниже: iOS после блокировки/смены сети часто
    // оставляет сокет в состоянии OPEN, который на деле мёртв — send()
    // уходит в никуда, onclose не приходит вовсе. Единственный честный
    // признак жизни — входящие данные.
    let lastMessageAt = Date.now();

    function connect() {
      if (isDisposed) return;
      // Уже есть живое или строящееся соединение — второе не открываем
      // (connect зовут и сторож, и visibility, и таймер реконнекта).
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      )
        return;
      try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
          lastMessageAt = Date.now();
          // При успешном подключении сразу обновляем задачи и уведомления
          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["tasks"] });
        };

        socket.onmessage = (evt) => {
          lastMessageAt = Date.now();
          let data: any;
          try {
            data = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (
            data?.type === "connected" ||
            data?.type === "ping" || // сигнал «на связи» от сервера (28.09.2026)
            data?.type === "pong" ||
            data?.type === "error"
          )
            return;

          // Своя ветка ДО общей инвалидации — иначе каждое действие агента
          // тоже дёргало бы кэш задач.
          if (data?.type === "task:activity") {
            for (const listener of activityListeners) listener(data);
            return;
          }

          if (data?.type === "chat:new") {
            for (const listener of chatListeners) listener(data);
            return;
          }

          if (data?.type === "chat:typing") {
            for (const listener of chatTypingListeners) listener(data);
            return;
          }

          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["tasks"] });
          qc.invalidateQueries({ queryKey: ["projects"] });
        };

        socket.onclose = () => {
          socket = null;
          if (!isDisposed) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };

        socket.onerror = () => {
          if (socket) {
            socket.close();
          }
        };
      } catch {
        if (!isDisposed) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    // Пинг + сторож. Пинг сам по себе жизнь не доказывает (см.
    // lastMessageAt выше): на полумёртвом сокете send() не бросает ошибку.
    // Поэтому проверяем ВХОДЯЩИЙ трафик: сервер отвечает pong'ом на каждый
    // пинг, значит на живом сокете тишина дольше двух пинг-интервалов
    // невозможна. Молчит — принудительно закрываем; onclose уже умеет
    // переподключаться, а onopen после реконнекта инвалидирует кэш — то
    // есть пропущенные за время «комы» события (статусы подзадач,
    // task:updated) подтянутся сами, без выхода-захода в раздел.
    const PING_MS = 20_000;
    const SILENCE_LIMIT_MS = PING_MS * 2 + 5_000;
    pingInterval = setInterval(() => {
      if (!socket) return;
      if (socket.readyState === WebSocket.OPEN) {
        if (Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
          // Полумёртвый сокет: OPEN, но сервер давно не отвечал.
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_MS);

    // При возвращении экрана из бэкграунда/блокировки сразу переподключаем
    // и обновляем кэш. Проверка не только readyState: после разблокировки
    // iOS сокет сплошь и рядом числится OPEN, будучи мёртвым (см. сторож
    // выше) — если от сервера давно не было ни байта, пересоздаём
    // принудительно, не дожидаясь, пока сторож досчитает своё.
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["tasks"] });
        qc.invalidateQueries({ queryKey: ["notifications"] });
        const stale = Date.now() - lastMessageAt > SILENCE_LIMIT_MS;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          connect();
        } else if (stale) {
          socket.close(); // onclose сам переподключит
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    return () => {
      isDisposed = true;
      clearInterval(pingInterval);
      clearTimeout(reconnectTimeout);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
      if (socket) {
        socket.close();
      }
    };
  }, [enabled, qc]);
}
