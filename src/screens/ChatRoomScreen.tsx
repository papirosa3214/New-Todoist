// Экран одной комнаты чата с ролями-агентами. Лента сообщений,
// композер внизу, меню создателя «···» для удаления.
//
// Это НЕ src/screens/ChatScreen.tsx: тот — для служебной переписки
// поверх карточки задачи (/chat). Здесь — отдельные сущности «чат с
// ролями» (/chats/:id), своя лента, свой композер, свои ключи кэша.
// Совпадений по возможности избегаем: если что-то пересечётся —
// ширина пузырей, отступы, композер, — это будет случайностью, а не
// «общим компонентом», потому что семантика разная (там — координация
// задачи, здесь — разговор с ролью в свободной форме).
//
// Пузырь: ровно тот же визуальный язык, что в старом ChatScreen, чтобы
// не множить приёмы — слева аватар роли (28px), справа у владельца
// пузырь с акцентным фоном. Разметка упрощена: адресат/тема не
// показываются, потому что в чате с ролями сообщение идёт «в ленту», а
// не конкретному адресату (выбор роли делает сервер через @упоминание
// или авто-подбор, см. server/src/routes/chats.ts:pickRoleForChat).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useChat,
  useChatMessages,
  useChatsLiveUpdates,
  useDeleteChat,
  useSendChatMessage,
} from "../api/chats";
import { useCurrentUser } from "../api/auth";
import { formatRelativeTime, formatAbsoluteTime } from "../lib/date";
import {
  Avatar,
  Button,
  ErrorBanner,
  Icon,
  Loading,
  ScreenHeader,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import type { ApiChatRoomMessage } from "../api/types";

export function ChatRoomScreen() {
  const { id } = useParams<{ id: string }>();
  const chatId = id ?? null;
  const navigate = useNavigate();
  const { confirm, dialog } = useDialog();
  const { data: me } = useCurrentUser();
  const { data: chat, isLoading, isError, error } = useChat(chatId);
  const {
    data: messages = [],
    isLoading: isMessagesLoading,
    isError: isMessagesError,
    error: messagesError,
  } = useChatMessages(chatId);
  // Живые ответы ролей — ws.ts → onChatMessage → фильтр по chat_id.
  useChatsLiveUpdates(chatId);
  const send = useSendChatMessage(chatId ?? "");
  const deleteChat = useDeleteChat();

  // Чужих отправителей (не себя) показываем с аватаром и именем.
  // Свои — справа, без аватара (он и так весь экран).
  const meId = me?.id;

  // Автоскролл к низу при появлении новых сообщений и при открытии.
  // Якорь-невидимка после последнего пузыря.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  useEffect(() => {
    // И при самом монтаже — на случай, если список пришёл из кэша и
    // длина не меняется.
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chatId]);

  const handleDelete = async () => {
    if (!chat) return;
    const ok = await confirm({
      title: "Удалить чат?",
      description:
        "История сообщений пропадёт без возможности восстановления.",
      confirmLabel: "Удалить",
      cancelLabel: "Отмена",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteChat.mutateAsync(chat.id);
      navigate("/chats", { replace: true });
    } catch {
      // Ошибка уже в mutation.error — на этом экране не показываем,
      // диалог закрылся, и вторая попытка сразу просится обратно.
    }
  };

  const isCreator = !!chat && !!meId && chat.created_by === meId;

  return (
    <div className="px-4 pb-4 flex flex-col h-[calc(100dvh-var(--screen-header-h,0px))]">
      {dialog}

      <ScreenHeader
        variant="compact"
        title={chat?.title || "Чат"}
        actions={
          isCreator && chat ? (
            <button
              onClick={handleDelete}
              aria-label="Удалить чат"
              className="w-[44px] h-[44px] -mr-2.5 flex items-center justify-center text-sub tap-row"
            >
              <Icon name="trash" size={18} />
            </button>
          ) : null
        }
      />

      {isLoading && <Loading variant="block" />}
      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить чат."
      />

      {chat && (
        <div className="text-[12px] text-sub mb-3 px-1">
          {participantSummary(chat.members, meId)}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto -mx-4 px-4"
      >
        {isMessagesLoading && <Loading variant="block" />}
        <ErrorBanner
          error={isMessagesError ? messagesError : null}
          fallback="Не удалось загрузить историю."
        />

        {messages.length === 0 && !isMessagesLoading && !isMessagesError && (
          <EmptyChat />
        )}

        <ul className="flex flex-col gap-3 py-2">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} mine={m.from_user_id === meId} />
          ))}
        </ul>
        <div ref={bottomRef} />
      </div>

      {chat && (
        <Composer
          disabled={send.isPending || !chatId}
          onSend={async (text) => {
            if (!chatId) return;
            await send.mutateAsync({ text });
          }}
        />
      )}
      <ErrorBanner
        error={send.error}
        fallback="Не удалось отправить сообщение."
        className="mt-2"
      />
    </div>
  );
}

function MessageBubble({
  msg,
  mine,
}: {
  msg: ApiChatRoomMessage;
  mine: boolean;
}) {
  // Без автора сообщения (анонимное системное — на случай, если в
  // будущем сервер начнёт писать что-то от своего имени) рисуем
  // «—» как у ChatScreen, чтобы карточка не схлопывалась.
  return (
    <li className={`flex gap-2 ${mine ? "flex-row-reverse" : ""}`}>
      {!mine && (
        <Avatar
          initials={msg.from_user_initials || "?"}
          color={msg.from_user_color || "#A6A6A6"}
          avatar_url={msg.from_user_avatar_url}
          size={28}
        />
      )}
      <div
        className={`flex flex-col max-w-[78%] ${
          mine ? "items-end" : "items-start"
        }`}
      >
        {!mine && msg.from_user_name && (
          <div className="text-[12px] text-sub px-1 mb-0.5">
            {msg.from_user_name}
          </div>
        )}
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-[14px] leading-snug whitespace-pre-wrap break-words ${
            mine ? "bg-red text-white" : "bg-card text-text"
          }`}
        >
          {msg.text}
        </div>
        <div className="text-[11px] text-dim mt-0.5 px-1">
          {formatRelativeTime(msg.created_at)} ·{" "}
          {formatAbsoluteTime(msg.created_at)}
        </div>
      </div>
    </li>
  );
}

function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    await onSend(trimmed);
  };

  return (
    <div className="pt-2 flex items-end gap-2">
      <div className="flex-1 bg-card2 rounded-2xl px-3.5 py-2.5 min-h-[44px] flex items-center">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter — отправка, Shift+Enter — перенос. Тот же приём,
            // что в существующем ChatScreen, чтобы поведение не
            // зависело от того, в каком чате пользователь сидит.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Сообщение…"
          rows={1}
          className="w-full bg-transparent text-[15px] text-text placeholder:text-dim outline-none resize-none max-h-32"
        />
      </div>
      <Button
        variant="primary"
        onClick={() => void send()}
        disabled={disabled || !text.trim()}
        // Чтобы кнопка была квадратной (как Send в существующем
        // ChatScreen), а не на всю ширину — отдельный класс вместо
        // дефолтной w-full.
        className="!w-12 !h-12 !p-0 shrink-0"
        aria-label="Отправить"
      >
        <Icon name="arrowUp" size={20} className="text-white" />
      </Button>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      <div className="w-12 h-12 rounded-full bg-card2 flex items-center justify-center mb-3">
        <Icon name="chat" size={20} className="text-sub" />
      </div>
      <p className="text-[14px] text-sub leading-relaxed max-w-[260px]">
        Сообщений ещё нет — напишите первым.
      </p>
    </div>
  );
}

/** Строка «Вы + Архитектор + QA» под заголовком. Короткие имена
 *  склеиваем через «+»; на групповом чате с пятью ролями выводим
 *  «Вы + 4 роли», чтобы строка не растягивалась на две. */
function participantSummary(
  members: { id: string; name: string }[],
  meId: string | undefined,
): string {
  const others = members.filter((m) => m.id !== meId);
  const head = others.slice(0, 2).map((m) => m.name);
  const overflow = others.length - head.length;
  const parts: string[] = [];
  if (meId) parts.push("Вы");
  parts.push(...head);
  if (overflow > 0) parts.push(`+${overflow}`);
  return parts.join(" + ") || "Чат";
}
