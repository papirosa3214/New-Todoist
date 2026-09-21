// Клиент API чатов с ролями-агентами (этап 8 клиент, этап 1 сервера:
// server/src/routes/chats.ts). Отдельный модуль, не chat.ts — тот
// обслуживает служебную переписку оркестратора/исполнителей (channel
// 'owner'/'agents', путь /api/chat). Здесь — сущность «чат»
// (channel 'chat', путь /api/chats), и кэш react-query тоже отдельный
// (префикс ["chats", ...]), чтобы invalidate одного не задевал другой.
//
// Живые обновления ловятся через общий ws-канал: тот же broadcast
// {type:"chat:new", message:{...}}, что и для старого чата — но
// фильтруем по message.chat_id, чтобы добавить строку в нужную комнату
// (а не перечитывать всю историю на каждое сообщение, см. B5 на
// сервере: ответы ролей могут приходить быстро).

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { onChatMessage } from "./ws";
import type { ApiChat, ApiChatRoomMessage } from "./types";

// ───────── список моих чатов ─────────

/** GET /api/chats. На каждый чат сервер возвращает полный состав
 *  участников + превью последнего сообщения — этого достаточно для
 *  карточки в списке, отдельный запрос на детали не нужен до открытия
 *  комнаты. */
export function useChats() {
  return useQuery({
    queryKey: ["chats", "list"],
    queryFn: () => api.get<{ chats: ApiChat[] }>("/api/chats"),
    select: (data) => data.chats,
  });
}

// ───────── одна комната ─────────

/** GET /api/chats/:id. Состав участников — нужно для шапки комнаты и
 *  для меню «···» (добавить/убрать роль). Возвращается чат целиком, без
 *  last_message: на экране комнаты это поле не нужно — там полная
 *  история отдельным запросом. */
export function useChat(chatId: string | null) {
  return useQuery({
    queryKey: ["chats", "detail", chatId],
    queryFn: () => api.get<{ chat: ApiChat }>(`/api/chats/${chatId}`),
    select: (data) => data.chat,
    enabled: !!chatId,
  });
}

// ───────── история сообщений комнаты ─────────

/** GET /api/chats/:id/messages. Сервер отдаёт по возрастанию времени,
 *  пагинации в v1 нет (см. аналогичный комментарий в useChatHistory
 *  для старого чата). */
export function useChatMessages(chatId: string | null) {
  return useQuery({
    queryKey: ["chats", "messages", chatId],
    queryFn: () =>
      api.get<{ messages: ApiChatRoomMessage[] }>(
        `/api/chats/${chatId}/messages`,
      ),
    select: (data) => data.messages,
    enabled: !!chatId,
  });
}

// ───────── создание чата ─────────

/** POST /api/chats. member_ids — роли-агенты (id вида role_*); для
 *  direct-чата сервер ожидает ровно одно значение, для group — любое
 *  число ≥1. Создатель добавляется участником автоматически — это
 *  серверная инварианта, клиенту себя в список совать не надо.
 *  После создания — invalidate списка, чтобы новый чат появился без
 *  перезахода. */
export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title?: string | null;
      kind: "direct" | "group";
      member_ids: string[];
    }) => api.post<{ chat: ApiChat }>("/api/chats", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    },
  });
}

// ───────── отправка сообщения ─────────

/** POST /api/chats/:id/messages. Ответ сервера содержит своё же
 *  сообщение с джойненными полями автора — кладём его в кэш
 *  оптимистично, чтобы пузырь не моргал. Чужой ответ (от роли)
 *  придёт отдельным chat:new и подхватится живым апдейтом. */
export function useSendChatMessage(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string }) =>
      api.post<{ message: ApiChatRoomMessage }>(
        `/api/chats/${chatId}/messages`,
        body,
      ),
    // Префиксный ключ — invalidateQueries накроет и messages текущего
    // чата, и все остальные ранее открытые (страховки нет, но дешевле
    // перечитать один раз, чем держать две подписки).
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats", "messages", chatId] });
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    },
  });
}

// ───────── состав чата ─────────

/** Добавить участника (создатель чата; сервер это проверяет). */
export function useAddChatMember(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      api.post<{ chat: ApiChat }>(`/api/chats/${chatId}/members`, {
        member_id: memberId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats", "detail", chatId] });
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    },
  });
}

/** Убрать участника (создатель; себя убрать нельзя — сервер режет 400). */
export function useRemoveChatMember(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      api.delete<{ chat: ApiChat }>(
        `/api/chats/${chatId}/members/${memberId}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats", "detail", chatId] });
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    },
  });
}

// ───────── удаление чата ─────────

/** DELETE /api/chats/:id. Создатель — единственный, кому сервер даст;
 *  экран сам прячет кнопку под «···», если current user != created_by. */
export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      api.delete<{ ok: true }>(`/api/chats/${chatId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    },
  });
}

// ───────── живые обновления ─────────

/** Подписка на chat:new, отфильтрованная по chatId. Сервер шлёт
 *  сообщения всем участникам чата (включая создателя-владельца), и
 *  внутри одного чата они идут в одном порядке. Если открыто несколько
 *  комнат одновременно — каждая подписка слушает только своё, чтобы
 *  не перечитывать всю историю на каждое чужое сообщение.
 *
 *  Подписчик вешается один раз на смонтированный экран; в Layout.tsx
 *  общий onChatMessage уже обрабатывается для старого чата — ключи
 *  ["chats", ...] vs ["chat", ...] не пересекаются, поэтому общая
 *  инвалидация одного не задевает другой.
 *
 *  Здесь не подменяем весь список, а точечно добавляем строку в кэш
 *  messages — это дешевле, чем invalidate и GET всей истории. */
export function useChatsLiveUpdates(chatId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!chatId) return;
    return onChatMessage((event) => {
      // event.message приходит «как есть» с сервера; chat_id лежит
      // внутри через индексную подпись ws.ts. Без него мы бы
      // перечитывали историю в каждой открытой комнате на любое
      // сообщение любого чата — это и есть тот шквал, от которого
      // ушли в useChatLiveUpdates. Каст через unknown: ws.ts
      // намеренно держит message слабо типизированным (одно и то же
      // событие обслуживает и старый chat, и новый chats), и без
      // двойного приведения TS-2352 ругается на недостаточное
      // перекрытие полей.
      const incoming = event.message as unknown as ApiChatRoomMessage;
      if (!incoming || incoming.chat_id !== chatId) return;
      qc.setQueryData<ApiChatRoomMessage[]>(
        ["chats", "messages", chatId],
        (prev) => {
          if (!prev) return prev;
          // Дубликат — на случай, если POST ещё и через onSuccess сам
          // дописал/инвалидировал.
          if (prev.some((m) => m.id === incoming.id)) return prev;
          return [...prev, incoming];
        },
      );
      // Шапку списка тоже подновим: превью last_message могло
      // устареть.
      qc.invalidateQueries({ queryKey: ["chats", "list"] });
    });
  }, [chatId, qc]);
}
