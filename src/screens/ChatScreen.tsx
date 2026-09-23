import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Paperclip } from "lucide-react";
import { useCurrentUser } from "../api/auth";
import {
  useChatHistory,
  useChatLiveUpdates,
  useChatParticipants,
  useChatTyping,
  useMarkChatRead,
  useSendChatMessage,
} from "../api/chat";
import { attachmentUrl } from "../api/attachments";
import { formatRelativeTime, formatAbsoluteTime } from "../api/notifications";
import type { ApiChatMessage, ChatChannel } from "../api/types";
import {
  Avatar,
  BackButton,
  ErrorBanner,
  Icon,
  Loading,
  ScreenHeader,
} from "../components/UI";
import { ChatComposer } from "../components/ChatComposer";
import { ChatStatsSheet } from "../components/ChatStatsSheet";

/**
 * Кому адресовано — строкой над пузырём (28.08.2026, владелец: «как я должен
 * догадаться, что ты мне написал, не упомянув ни слова обо мне»).
 *
 * Обращение к себе Максим должен видеть, не вчитываясь, поэтому «тебе» —
 * единственное, что здесь набрано акцентом; такому сообщению достаётся ещё
 * и акцентная рамка на самом пузыре. Остальные адреса — приглушённая
 * подпись: они объясняют, кто с кем разговаривает, но не зовут.
 */
function AddressLine({
  msg,
  mine,
  toMe,
}: {
  msg: ApiChatMessage;
  mine: boolean;
  toMe: boolean;
}) {
  const target = toMe ? "тебе" : msg.to_user_id ? msg.to_user_name : "всем";
  return (
    <div
      className={`text-[12px] mb-0.5 px-1 ${mine ? "text-dim" : "text-sub"}`}
    >
      {!mine && <span>{msg.from_user_name || "—"} </span>}
      <span className={toMe ? "text-red font-semibold" : ""}>→ {target}</span>
    </div>
  );
}

function ChatBubble({
  msg,
  mine,
  toMe,
}: {
  msg: ApiChatMessage;
  mine: boolean;
  toMe: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div className={`flex gap-2 px-4 ${mine ? "flex-row-reverse" : ""}`}>
      {!mine && (
        <Avatar
          initials={msg.from_user_initials || "?"}
          color={msg.from_user_color || "#A6A6A6"}
          avatar_url={msg.from_user_avatar_url}
          size={28}
        />
      )}
      <div
        className={`flex flex-col max-w-[78%] ${mine ? "items-end" : "items-start"}`}
      >
        <AddressLine msg={msg} mine={mine} toMe={toMe} />
        {msg.text && (
          <div
            className={`rounded-2xl px-3.5 py-2.5 text-[14px] leading-snug whitespace-pre-wrap break-words ${
              mine
                ? "bg-red text-white"
                : toMe
                  ? "bg-card text-text border border-red"
                  : "bg-card text-text"
            }`}
          >
            {msg.text}
          </div>
        )}
        {/* Приложенные файлы. Картинка показывается сразу — за ней чаще
            всего и лезут; остальное строкой с именем. Пустой текст здесь
            законен: «вот скриншот» без подписи — нормальное сообщение,
            поэтому пузырь с текстом выше рисуется только если текст есть. */}
        {msg.attachments?.map((att) =>
          att.mime.startsWith("image/") ? (
            <a
              key={att.id}
              href={attachmentUrl(att.id)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block max-w-[220px] overflow-hidden rounded-2xl"
            >
              <img
                src={attachmentUrl(att.id)}
                alt={att.file_name}
                className="w-full h-auto"
              />
            </a>
          ) : (
            <a
              key={att.id}
              href={attachmentUrl(att.id)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex items-center gap-2 rounded-xl bg-card2 px-3 h-9 max-w-[220px]"
            >
              <Paperclip size={13} className="text-sub shrink-0" />
              <span className="min-w-0 truncate text-[12px] text-text">
                {att.file_name}
              </span>
            </a>
          ),
        )}
        {msg.task_id && msg.task_title && (
          <button
            onClick={() => navigate(`/task/${msg.task_id}`)}
            className="tap-fade text-[12px] text-sub mt-1 px-1 underline underline-offset-2"
          >
            {msg.task_title}
          </button>
        )}
        <div className="text-[11px] text-dim mt-0.5 px-1">
          {formatRelativeTime(msg.created_at)} ·{" "}
          {formatAbsoluteTime(msg.created_at)}
        </div>
      </div>
    </div>
  );
}

/**
 * «Кто сейчас работает» — строка под последним сообщением (29.08.2026,
 * задача a56f35f6: «отметка реально показывала бы факт того, что ты мне
 * сейчас пишешь» — заменили «печатает» на «работает», потому что сигнал
 * теперь по факту обращения агента к серверу, а не по вводу с клавиатуры).
 * Стоит В ЛЕНТЕ, а не в шапке: смотрят в низ переписки, туда же приходит
 * и сам ответ, за которым ждут.
 *
 * Имена перечисляются целиком, без «и ещё N»: участников канала шесть, а
 * работают одновременно в лучшем случае двое — сокращать нечего.
 */
function TypingLine({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const who =
    names.length === 1
      ? `${names[0]} работает…`
      : `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]} работают…`;
  return (
    <div className="flex items-center gap-2 px-4 text-[12px] text-sub">
      <span className="min-w-0 truncate">{who}</span>
      <span className="flex items-center gap-1 shrink-0">
        {[0, 0.2, 0.4].map((delay) => (
          <span
            key={delay}
            className="nt-typing-dot"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * «Отправил — жду ответ» (22.09.2026, заметка d7e98ed7): три точки без
 * подписи под последним пузырём. Те же точки, что и в «работает…», но
 * без текста — DESIGN.md не любит пояснять словами то, что видно по
 * картинке. Цвет text-dim чуть приглушённее, чем у TypingLine: без
 * подписи индикатору достаточно намёка, чтобы не конкурировать с
 * сообщением. Класс анимации тот же — переиспользуем существующий,
 * prefers-reduced-motion уже обработан в index.css.
 */
function AwaitingLine() {
  return (
    <div className="flex items-center gap-2 px-4 text-[12px] text-dim">
      <span className="flex items-center gap-1">
        {[0, 0.2, 0.4].map((delay) => (
          <span
            key={delay}
            className="nt-typing-dot"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * Переключатель каналов (28.08.2026, владелец: «должно быть тут 2 канала: у
 * нас с тобой, оркестратор, и другой канал между вами, чтобы я только для
 * контроля туда смотрел»).
 *
 * Первая вкладка названа именем собеседника, а не словом «мой канал»: у
 * владельца это оркестратор, у оркестратора — владелец, и в обоих случаях
 * человек читает вкладку как «разговор с ним». Вторая — служебная лента,
 * куда владелец заходит смотреть, а не разговаривать.
 *
 * Рост 44 — минимальная тап-зона по DESIGN.md; внутренняя рамка 3px даёт
 * сегменту 38 и оставляет активный «язычок» приподнятым над подложкой.
 */
function ChannelTabs({
  value,
  onChange,
  counterpartName,
}: {
  value: ChatChannel;
  onChange: (channel: ChatChannel) => void;
  counterpartName: string;
}) {
  const tabs: Array<{ id: ChatChannel; label: string }> = [
    { id: "owner", label: counterpartName },
    { id: "agents", label: "Агенты" },
  ];
  return (
    <div className="mx-4 mt-2 flex h-11 items-center gap-1 rounded-xl bg-card2 p-[3px]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`flex-1 h-[38px] rounded-lg text-[14px] tap-fade ${
            value === tab.id ? "bg-card text-text" : "text-sub"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function ChatScreen() {
  // Хуки, от которых зависит логика ниже — поднимаем ДО useState и
  // useChatLiveUpdates. До правки useCurrentUser() стоял ниже, и callback
  // «отправил — жду ответ» замыкался на ещё не инициализированный me —
  // формально работало через ref внутри useChatLiveUpdates, но читалось
  // вкривь и в первые миллисекунды после открытия экрана условие
  // «ответ лично мне» не срабатывало (me === undefined).
  const navigate = useNavigate();
  const { data: me } = useCurrentUser();
  const { data: participants = [] } = useChatParticipants();

  // «Отправил — жду ответ» (заметка d7e98ed7). Хранится здесь, а не в
  // общем кеше: индикатор — локальное состояние разговора, не нужно
  // светить его в других вкладках. messageId нужен только как ключ
  // таймаута, чтобы повторная отправка перезапускала отсчёт.
  const [awaiting, setAwaiting] = useState<
    { messageId: string; toUserId: string } | null
  >(null);

  // Живые обновления, пока экран открыт — не в Layout.tsx (общий сокет там
  // уже есть для notifications/tasks, но эта подписка нужна только тут).
  // Колбэк сбрасывает индикатор «отправил — жду ответ», когда в канал
  // приходит сообщение от моего адресата (или мне лично). Логика —
  // здесь, а не в хуке: только ChatScreen знает, кому он сейчас пишет.
  useChatLiveUpdates((event) => {
    const m = event.message;
    if (!m || m.from_user_id === me?.id) return;
    setAwaiting((cur) => {
      if (!cur) return cur;
      // Ответ лично мне — всегда гасит, в любом канале.
      if (m.to_user_id === me?.id) return null;
      // Сообщение от моего адресата (когда я писал лично) — гасит.
      // Если я писал «всем» (cur.toUserId === "all"), это условие
      // пропускается: жду первого ответа ЛИЧНО мне, чужая переписка
      // мимо меня индикатор не гасит (спека, «Критерии приёмки»).
      if (cur.toUserId !== "all" && m.from_user_id === cur.toUserId)
        return null;
      return cur;
    });
  });

  // Две ленты видят только владелец и оркестратор — они и есть две стороны
  // первого канала. Остальным исполнителям выбирать нечего: у них одна
  // рабочая переписка, и переключатель им не показывается вовсе.
  const isOwner = me?.role === "owner";
  const isOrchestrator = me?.role === "orchestrator";
  const bothChannels = isOwner || isOrchestrator;
  const [channel, setChannel] = useState<ChatChannel>("owner");
  const activeChannel: ChatChannel = bothChannels ? channel : "agents";
  // Собеседник в первом канале: у владельца «Секретарь», у оркестратора —
  // владелец. Выбирать его не из чего, поэтому он не адресат из списка, а
  // просто вторая сторона разговора.
  //
  // 10.09.2026, карточка 4396f8c9: у владельца тут БЫЛ оркестратор, и первый
  // канал читался как разговор с ним. Автономного оркестратора решением
  // 08.09.2026 нет, а канал стал окном постановки задач: владелец наговаривает
  // сюда работу, её разбирает локальная модель, и ответ про собранную карточку
  // пишет «Секретарь» — учётка скрипта, не агент (миграция 028). Ищем его по
  // признакам, а не по зашитому идентификатору: единственный участник, который
  // машина (type=ai) и при этом не исполнитель (role=viewer).
  const counterpart = participants.find((p) =>
    isOwner ? p.role === "viewer" && p.type === "ai" : p.role === "owner",
  );
  // Служебная лента у владельца открыта и на запись. Первый заход прятал
  // здесь строку ввода — «смотришь для контроля» — и владелец сразу же это
  // отменил (28.08.2026): «написать я никому не могу, а мало ли мне
  // приспичит кого-то конкретно озадачить, а не оркестратора». Разгружали
  // его от чужой переписки, а не отбирали доступ: сюда он заходит сам и
  // адресата выбирает сам.

  const { data, isLoading, error, isError } = useChatHistory(
    null,
    activeChannel,
  );
  const typists = useChatTyping();
  const sendMessage = useSendChatMessage();
  const markRead = useMarkChatRead();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Строка ввода — position:fixed (index.css, .nt-composer), места в потоке
  // не занимает. Её высоту подкладываем под ленту, иначе последнее
  // сообщение оказывается под ней.
  const [composerH, setComposerH] = useState(60);
  const [statsOpen, setStatsOpen] = useState(false);

  // Открыл экран — считается прочитанным (тот же принцип, что у
  // уведомлений): бейдж на табе гасит накопленное, не дожидаясь, пока
  // дочитают каждое сообщение по отдельности.
  useEffect(() => {
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const messages = data?.messages ?? [];
  // Себя в отметке не показываем: своё «печатает» человек и так видит по
  // собственной клавиатуре.
  const typingNames = typists
    .filter((t) => t.user_id !== me?.id)
    // Отметка «печатает» общая на весь чат, а каналов теперь два: без этого
    // у Максима в его собственной ленте мигало бы «Гермес печатает» из
    // служебной переписки — ровно то втягивание, от которого уходили.
    .filter((t) => activeChannel !== "owner" || t.user_id === counterpart?.id)
    .map((t) => t.name);

  // Докручиваем вниз и на новое сообщение, и на смену высоты строки ввода:
  // клавиатура открывается — видимая часть ленты сжимается, и без этого
  // последнее сообщение уезжает под неё. Появление отметки «печатает» —
  // тот же случай: она встаёт под последним сообщением.
  //
  // Крутим до конца сам прокручиваемый контейнер, а не scrollIntoView по
  // метке в низу ленты. Разница не косметическая: у ленты снизу отступ на
  // высоту строки ввода, а scrollIntoView прижимает метку к нижнему краю
  // ОКНА и этот отступ уводит за экран — последняя строка встаёт ровно под
  // строкой ввода. Замерено 28.08.2026: низ отметки «печатает» на 892px при
  // верхе строки ввода 852px (то есть под ней), после честной прокрутки —
  // 780px, на 72px выше неё.
  //
  // Прокручивается при этом НЕ лента, а внешний контейнер экрана (Layout,
  // overflow-y-auto) — у самой ленты переполнения нет, и запись в её
  // scrollTop не делает ничего. Поэтому ищем ближайшего прокручиваемого
  // предка, а не полагаемся на догадку о том, кто здесь скроллер.
  //
  // Три захода подряд — потому что при открытии экрана пузыри ещё меряются
  // (аватарки, переносы, картинки): первый заход попадает в высоту, которой
  // через кадр уже нет, и лента останавливается выше низа.
  useEffect(() => {
    const toBottom = () => {
      let node: HTMLElement | null = scrollerRef.current;
      while (node) {
        const overflow = getComputedStyle(node).overflowY;
        if (
          (overflow === "auto" || overflow === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          node.scrollTop = node.scrollHeight;
          return;
        }
        node = node.parentElement;
      }
    };
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    const settle = setTimeout(toBottom, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [messages.length, composerH, typingNames.length]);

  const handleSend = useCallback(
    async (payload: {
      text: string;
      to_user_id: string;
      attachment_ids?: string[];
    }) => {
      const res = await sendMessage.mutateAsync({
        ...payload,
        channel: activeChannel,
      });
      // Индикатор «отправил — жду ответ». Ответ сервера приходит
      // синхронно с успешной отправкой — берём его, чтобы привязать
      // таймаут к конкретному сообщению.
      const messageId = res?.id;
      if (messageId) {
        setAwaiting({ messageId, toUserId: payload.to_user_id });
      }
    },
    [sendMessage, activeChannel],
  );

  // Таймаут 60 с (заметка d7e98ed7): если за это время никто из
  // адресатов не ответил — гасим. Собеседник имеет право молчать, и
  // вечная точка не нужна ни ему, ни нам. Зависимость по awaiting —
  // повторная отправка перезапускает отсчёт, ручной сброс отменяет
  // таймер чисто.
  useEffect(() => {
    if (!awaiting) return;
    const t = setTimeout(() => setAwaiting(null), 60_000);
    return () => clearTimeout(t);
  }, [awaiting]);

  return (
    <div className="flex flex-col h-full">
      {/* Кнопка «назад» ставится ЯВНО. Сама шапка её не рисует: /chat —
          корневая вкладка (NAV_ITEMS), а из корневого раздела уходить
          обычно некуда. Здесь другой случай: панель навигации на этом
          экране заменена строкой ввода, поэтому выход должен быть в шапке.
          Ведёт в «Обзор» — он же главное меню (владелец 28.08.2026: «тебе
          назад окошко нужно сделать, чтобы я возвращался в главное меню, а
          главное меню у нас обзор»). */}
      <ScreenHeader
        variant="compact"
        title={bothChannels ? "Чат" : "Чат агентов"}
        // Вкладки — ВНУТРИ шапки (проп below), а не блоком под ней. Шапка
        // прибита к окну (position: fixed, см. ScreenHeader), а обычный блок
        // уезжает вместе с лентой: чат открывается прокрученным в конец, и
        // переключатель оказывался за верхним краем — снят живьём
        // 28.08.2026, на экране его не было вовсе.
        below={
          bothChannels ? (
            <ChannelTabs
              value={activeChannel}
              onChange={setChannel}
              counterpartName={
                (counterpart?.name || (isOwner ? "Секретарь" : "Максим")).split(
                  " ",
                )[0]
              }
            />
          ) : undefined
        }
        leading={<BackButton onClick={() => navigate("/overview")} />}
        // Сводка живёт в шапке чата, а не отдельным разделом: смотрят её
        // оттуда же, где читают переписку, и по тому же поводу.
        actions={
          <button
            onClick={() => setStatsOpen(true)}
            aria-label="Кого озадачивают чаще всего"
            className="tap-scale w-11 h-11 flex items-center justify-center"
          >
            <Icon name="chart" size={18} className="text-text" />
          </button>
        }
      />

      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить чат"
        variant="inline"
        className="mx-4 mt-2"
      />

      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto"
        style={{ paddingBottom: composerH }}
      >
        {isLoading && <Loading className="mt-3" />}
        {!isLoading && messages.length === 0 && (
          <p className="px-5 text-[13px] text-dim mt-3">
            {/* У владельца первая вкладка — окно постановки задач, и пустой
                экран это единственное место, где можно сказать, что оно
                делает: дальше он сам увидит по ответам (карточка 4396f8c9). */}
            {activeChannel === "agents" && isOwner
              ? "Пока пусто — исполнители ещё не переписывались."
              : activeChannel === "owner" && isOwner
                ? "Пока пусто. Наговорите сюда задачу — разберу и соберу карточку-черновик, останется поставить флаг готовности."
                : "Пока пусто — первое сообщение здесь твоё."}
          </p>
        )}
        <div className="flex flex-col gap-3 pt-3">
          {messages.map((m) => (
            <ChatBubble
              key={m.id}
              msg={m}
              mine={m.from_user_id === me?.id}
              // «Мне» — именно личное обращение, а не сообщение всем: иначе
              // акцент стоял бы на каждой строке и перестал бы значить что-либо.
              toMe={!!me && m.to_user_id === me.id && m.from_user_id !== me.id}
            />
          ))}
          <TypingLine names={typingNames} />
          {awaiting && <AwaitingLine />}
        </div>
      </div>

      <ChatStatsSheet
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        meId={me?.id}
      />

      <ChatComposer
        participants={participants}
        meId={me?.id}
        // В первом канале собеседник один и тот же — вместо кнопки выбора
        // адресата стоит его лицо (см. ChatComposer, fixedAddressee). В
        // служебной ленте выбор адресата обычный: там их много.
        fixedAddressee={activeChannel === "owner" ? counterpart : null}
        onSend={handleSend}
        sending={sendMessage.isPending}
        sendError={sendMessage.error}
        onHeightChange={setComposerH}
      />
    </div>
  );
}
