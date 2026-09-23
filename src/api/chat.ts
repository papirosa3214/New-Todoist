import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { onChatMessage, onChatTyping, type ChatMessageEvent } from "./ws";
import type {
  ApiChatAttachment,
  ApiChatMessage,
  ApiChatParticipant,
  ApiChatStats,
  ChatChannel,
} from "./types";

/**
 * Файл в чат — сырыми байтами, как везде у нас (api/audio.ts, вложения
 * задач). Свой маршрут, а не общий с задачами: тот требует идентификатор
 * карточки в пути, а у сообщения чата карточки может не быть вовсе.
 *
 * Файл заливается ДО отправки сообщения и до неё лежит «ничьим» — ровно как
 * вложение комментария. Отправленное сообщение его подбирает; передумал —
 * убирается тем же DELETE /api/attachments/:id, что и остальные.
 */
export function uploadChatAttachment(
  file: File,
): Promise<{ attachment: ApiChatAttachment }> {
  return api.postBlob<{ attachment: ApiChatAttachment }>(
    `/api/chat/attachments?name=${encodeURIComponent(file.name)}`,
    file,
  );
}

export function useChatParticipants() {
  return useQuery({
    queryKey: ["chat", "participants"],
    queryFn: () => api.get<ApiChatParticipant[]>("/api/chat/participants"),
    staleTime: 5 * 60_000, // участники каналов не появляются на ходу
  });
}

// taskId=null — общая лента (весь канал, не привязанная к одной карточке).
// Без пагинации вперёд/назад в v1: экран держит последние 50, «загрузить
// ещё» — отдельным заходом, когда понадобится реально длинная история.
export function useChatHistory(
  taskId?: string | null,
  channel?: ChatChannel | null,
) {
  const params = new URLSearchParams();
  if (taskId) params.set("task_id", taskId);
  // Канал спрашивается ЯВНО. Без параметра сервер отдаёт всё, что видно
  // участнику, — для резидента это правильный дефолт, а на экране смешало
  // бы разговор владельца со служебной перепиской в одну ленту.
  if (channel) params.set("channel", channel);
  const qs = params.toString() ? `?${params}` : "";
  return useQuery({
    queryKey: ["chat", "history", taskId ?? null, channel ?? null],
    queryFn: () =>
      api.get<{ messages: ApiChatMessage[]; has_more: boolean }>(
        `/api/chat${qs}`,
      ),
  });
}

export function useSendChatMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      text: string;
      /** Обязателен с 28.08.2026: id участника или "all" (всем). Сервер
          отвечает 400, если поля нет — «молчаливо всем» больше не бывает. */
      to_user_id: string;
      /** Куда класть. Значим только для владельца: он один может писать в
          обе ленты, и без этого поля сервер увёл бы его сообщение из
          служебной переписки обратно в личный канал к оркестратору. */
      channel?: ChatChannel;
      task_id?: string;
      kind?: "совещание" | "делегирование" | "находка";
      attachment_ids?: string[];
    }) => api.post<ApiChatMessage>("/api/chat", body),
    // Префиксный ключ — invalidateQueries сам накроет и общую ленту
    // ["chat","history",null], и ленту конкретной задачи, без отдельного
    // вызова на каждую.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", "history"] });
    },
  });
}

/** Сводка «кто кого озадачивает». Считается по всей истории и меняется с
    каждым сообщением — держать её свежей незачем, читается по открытию. */
export function useChatStats(enabled = true) {
  return useQuery({
    queryKey: ["chat", "stats"],
    queryFn: () => api.get<ApiChatStats>("/api/chat/stats"),
    enabled,
  });
}

export function useChatUnread() {
  return useQuery({
    queryKey: ["chat", "unread"],
    queryFn: () => api.get<{ непрочитано: number }>("/api/chat/unread"),
  });
}

export function useMarkChatRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/chat/read"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", "unread"] }),
  });
}

// Живое обновление по сокету (onChatMessage — ws.ts, мимо общей
// invalidateQueries по тем же причинам, что task:activity). Один подписчик
// на всё приложение — достаточно смонтировать один раз там, где уже живёт
// сокет (App.tsx), а не в каждом экране, который читает историю чата.
//
// onIncoming (22.09.2026, заметка d7e98ed7) — опциональный колбэк для
// сброса индикатора «отправил — жду ответ» в ChatScreen. Сам стейт
// awaiting живёт в ChatScreen и сюда не поднимается: глобальный кеш для
// этого не нужен (см. спеку, раздел «Поведение»), а передать логику
// «когда гасить» мимо ChatScreen нельзя — только он знает, кто там
// адресат.
export function useChatLiveUpdates(
  onIncoming?: (event: ChatMessageEvent) => void,
) {
  const qc = useQueryClient();
  // Колбэк держим в ref, чтобы смена ссылки на каждый рендер не
  // переподписывалась на сокет. Сам сокет один на приложение, и
  // отписка/подписка при каждом сообщении — лишняя работа.
  const cbRef = useRef(onIncoming);
  useEffect(() => {
    cbRef.current = onIncoming;
  }, [onIncoming]);
  useEffect(() => {
    return onChatMessage((event) => {
      qc.invalidateQueries({ queryKey: ["chat", "history"] });
      qc.invalidateQueries({ queryKey: ["chat", "unread"] });
      cbRef.current?.(event);
    });
  }, [qc]);
}

export interface ChatTypist {
  user_id: string;
  name: string;
}

/** Как часто пересматриваем сроки — секунды хватает: отметка должна гаснуть
 *  «сразу же», а не мгновенно, лишние перерисовки тут ни к чему. */
const TYPING_TICK_MS = 1000;

/**
 * Кто прямо сейчас готовит сообщение.
 *
 * Гаснет само тремя путями, и все три нужны: сервер шлёт «перестал» (ушёл
 * со связи, отправил сообщение, протух его срок), приход самого сообщения
 * снимает отметку с автора мгновенно (событие «перестал» и «новое
 * сообщение» идут порознь, и без этого пузырь на долю секунды соседствовал
 * бы с «печатает…» того же участника), а местный таймер добивает случай,
 * когда до нас не дошло ничего вообще: сокет умер молча, сервер лежит.
 * Последнее и есть ответ на «чтобы не висела вечно» — отметка не может
 * пережить собственный срок, что бы ни случилось со связью.
 */
export function useChatTyping(): ChatTypist[] {
  const [typists, setTypists] = useState<ChatTypist[]>([]);
  // Сроки живут в ref, а не в state: они меняются на каждое нажатие клавиши
  // собеседника, а перерисовка нужна, только когда меняется САМ СПИСОК.
  const deadlines = useRef(new Map<string, { name: string; until: number }>());

  const sync = useCallback(() => {
    const now = Date.now();
    for (const [id, entry] of deadlines.current) {
      if (entry.until <= now) deadlines.current.delete(id);
    }
    const next = [...deadlines.current.entries()].map(([user_id, entry]) => ({
      user_id,
      name: entry.name,
    }));
    setTypists((prev) => {
      const same =
        prev.length === next.length &&
        prev.every((p, i) => p.user_id === next[i].user_id);
      return same ? prev : next;
    });
  }, []);

  useEffect(() => {
    let alive = true;

    // Снимок при открытии экрана. Без него отметка появлялась бы только у
    // того, кто уже сидел в чате, когда собеседник начал печатать: событие
    // ушло по сокету до подписки.
    api
      .get<{
        typing: Array<{ user_id: string; name: string; ttl_ms: number }>;
      }>("/api/chat/typing")
      .then((snapshot) => {
        if (!alive) return;
        const now = Date.now();
        for (const t of snapshot.typing) {
          deadlines.current.set(t.user_id, {
            name: t.name,
            until: now + t.ttl_ms,
          });
        }
        sync();
      })
      .catch(() => {
        // Снимок необязателен: живые события всё равно придут по сокету.
      });

    const offTyping = onChatTyping((event) => {
      if (event.state === "stop") deadlines.current.delete(event.user_id);
      else
        deadlines.current.set(event.user_id, {
          name: event.name,
          until: Date.now() + event.ttl_ms,
        });
      sync();
    });

    const offMessage = onChatMessage((event) => {
      deadlines.current.delete(event.message.from_user_id);
      sync();
    });

    const tick = setInterval(sync, TYPING_TICK_MS);

    return () => {
      alive = false;
      offTyping();
      offMessage();
      clearInterval(tick);
    };
  }, [sync]);

  return typists;
}

/** Не чаще одного сигнала в это окно: печатающий человек иначе слал бы
 *  запрос на каждую букву. Заметно меньше срока отметки на сервере (8 с у
 *  человека), чтобы она успевала продлеваться, пока он правда печатает. */
const TYPING_SIGNAL_THROTTLE_MS = 3000;

/**
 * Сигнал «я печатаю» со стороны человека: шлётся из строки ввода, пока в
 * ней что-то набирают. Отдельного продления нет — продлевает сам факт
 * набора; замолчал, отправил или очистил поле — отметка гаснет.
 */
export function useTypingSignal() {
  const lastSentAt = useRef(0);

  const signal = useCallback((typing: boolean) => {
    if (!typing) {
      // Гасить нечего, если и не зажигали: иначе каждый уход фокуса с
      // пустого поля слал бы серверу «перестал печатать».
      if (!lastSentAt.current) return;
      lastSentAt.current = 0;
      api.post("/api/chat/typing", { state: "stop" }).catch(() => {});
      return;
    }
    const now = Date.now();
    if (now - lastSentAt.current < TYPING_SIGNAL_THROTTLE_MS) return;
    lastSentAt.current = now;
    // Сигнал — не доставка: упавший запрос не должен мешать набору текста.
    api.post("/api/chat/typing", {}).catch(() => {});
  }, []);

  return signal;
}
