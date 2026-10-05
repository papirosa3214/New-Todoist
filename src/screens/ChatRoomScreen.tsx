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

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useChat,
  useChatMessages,
  useChatsLiveUpdates,
  useDeleteChat,
  useSendChatMessage,
} from "../api/chats";
import { useCurrentUser } from "../api/auth";
import {
  formatAbsoluteTime,
  formatDaySeparator,
  formatRelativeTime,
  getMskDayKey,
} from "../lib/date";
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

// Отступ в px от низа ленты, при котором пользователь считается
// «у дна» — на эту величину ниже реального низа может уехать
// scrollTop из-за дробей/растягивания, и это всё ещё «у дна».
// 80px — высота 3-4 пузырей плюс композер, при которых «у дна»
// читается глазами.
const NEAR_BOTTOM_PX = 80;

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
  //
  // Правило «когда скроллить»: если пользователь и так сидит у дна
  // (или в пределах NEAR_BOTTOM_PX), новое сообщение должно прийти
  // ему в поле зрения, как в Telegram/WhatsApp. Если он ушёл читать
  // историю — НЕ дёргаем ленту, иначе он теряет место, где остановился.
  // В этом случае кнопка «↓» в правом нижнем углу возвращает на дно
  // одним нажатием.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Реф вместо setAtBottom в эффекте: state-апдейт там же зациклит
  // автоскролл (каждый рендер — новое значение — снова рендер). Через
  // ref пишем «у дна?» моментально, а в state выставляем только когда
  // оно поменялось (для видимости кнопки).
  atBottomRef.current = atBottom;
  useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  useEffect(() => {
    // И при самом монтаже — на случай, если список пришёл из кэша и
    // длина не меняется.
    atBottomRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chatId]);

  // Слушаем скролл: если пользователь ушёл от дна больше чем на
  // NEAR_BOTTOM_PX — показываем кнопку «вниз». Если вернулся — прячем.
  // scrollHeight здесь уменьшать не нужно: высота растёт только при
  // добавлении сообщений, а этот слушатель срабатывает на пользовательский
  // ввод, а не на появление новых пузырей.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = distance <= NEAR_BOTTOM_PX;
      if (near !== atBottomRef.current) setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

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
 <div className="tf-meta text-sub mb-3 px-1">
          {participantSummary(chat.members, meId)}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto -mx-4 px-4"
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
            {messages.map((m, i) => {
              // Разделитель суток вставляем перед первым сообщением
              // нового календарного дня (по Москве). Если у соседних
              // сообщений день совпадает — не дублируем. Сравнение по
              // ключу «YYYY-MM-DD», а не по строке created_at: дата
              // хранится в UTC, а день считается московский.
              const prev = i > 0 ? messages[i - 1] : null;
              const showDaySeparator =
                !prev || getMskDayKey(prev.created_at) !== getMskDayKey(m.created_at);
              return (
                <Fragment key={m.id}>
                  {showDaySeparator && (
                    <DaySeparator label={formatDaySeparator(m.created_at)} />
                  )}
                  <MessageBubble msg={m} mine={m.from_user_id === meId} />
                </Fragment>
              );
            })}
          </ul>
          <div ref={bottomRef} />
        </div>

        {/* Плавающая кнопка «к последнему сообщению». Появляется только
            когда пользователь ушёл вверх по ленте; видна поверх пузырей,
            не уезжает со скроллом (position: absolute относительно
            обёртки). Без неё, чтобы вернуться вниз после прочтения
            истории, пришлось бы свайпать пальцем через всю ленту —
            на длинных чатах это десятки пузырей. */}
        {!atBottom && (
          <button
            type="button"
            onClick={() => {
              atBottomRef.current = true;
              setAtBottom(true);
              bottomRef.current?.scrollIntoView({ block: "end" });
            }}
            aria-label="К последнему сообщению"
            className="absolute right-3 bottom-3 w-11 h-11 rounded-full bg-card shadow-fab z-10 flex items-center justify-center text-text tap-fade"
          >
            <Icon name="arrowDown" size={20} />
          </button>
        )}
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
 <div className="tf-meta text-sub px-1 mb-0.5">
            {msg.from_user_name}
          </div>
        )}
        <div
 className={`tf-row rounded-2xl px-3.5 py-2.5 leading-snug whitespace-pre-wrap break-words ${
            mine ? "bg-red text-white" : "bg-card text-text"
          }`}
        >
          {msg.text}
        </div>
 <div className="tf-caption text-dim mt-0.5 px-1">
          {formatRelativeTime(msg.created_at)} ·{" "}
          {formatAbsoluteTime(msg.created_at)}
        </div>
      </div>
    </li>
  );
}

/** Разделитель календарных суток в ленте. Тот же приём, что в
 *  Telegram/WhatsApp: тонкая линия с подписью по центру, чтобы при
 *  прокрутке истории сразу было видно, где проходят границы дней.
 *  Без подписи взгляд скользит по сплошному потоку пузырей и теряется
 *  ощущение, насколько старая та или иная «сессия» (владелец
 *  02.10.2026). */
function DaySeparator({ label }: { label: string }) {
  return (
    <li
      aria-label={label}
      className="flex items-center gap-2 py-1.5 select-none"
    >
      <div className="flex-1 h-px bg-card2" />
 <span className="tf-caption text-dim font-medium tracking-wide uppercase">
        {label}
      </span>
      <div className="flex-1 h-px bg-card2" />
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
 className="tf-body w-full bg-transparent text-text placeholder:text-dim outline-none resize-none max-h-32"
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
 <p className="tf-row text-sub leading-relaxed max-w-[260px]">
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
