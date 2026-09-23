import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { ActionsMenu } from "./ActionsMenu";
import { Avatar, ErrorBanner, Icon } from "./UI";
import { MicOverlay } from "./MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { combineDictatedText } from "../lib/dictationParser";
import { uploadChatAttachment, useTypingSignal } from "../api/chat";
import { api } from "../api/client";
import type { ApiChatAttachment, ApiChatParticipant } from "../api/types";

// ═══════════ СТРОКА ВВОДА ЧАТА ═══════════
//
// Заменяет собой панель навигации на /chat (28.08.2026, владелец: «вот это
// окно ввода нужно всё-таки приземлить, прилепить — на замену этой менюшке
// с плюсиком; я открываю чатик, и у меня вся страничка исключительно
// чатика, это единственное окно, где это уместно»).
//
// ── Геометрия считается, а не подбирается ──
//
// Повод прямой: «кнопка тоже не в размер окна ввода — сделай одинаковый.
// Посчитай математику, интервалы, чтобы всё было симметрично». Было поле
// 44px и кнопка 40px, потому что оба числа выбирались отдельно.
//
// Теперь всё выводится из ОДНОГО: размера шрифта поля.
//
//   шрифт 16px  — меньше нельзя, iOS зумит экран при фокусе на поле
//   строка 16 × 1.5                                    = 24px
//   поля сверху и снизу по 10                          = 20px
//   ─────────────────────────────────────────────────────────
//   рост элемента строки H                             = 44px
//
// 44 — это же минимальная тап-зона по DESIGN.md, так что один размер
// закрывает и типографику, и попадание пальцем. От него всё остальное:
//
//   H = 44          рост поля, кнопки отправки, кнопки адресата
//   GAP = 8         между элементами строки (шаг сетки ×2)
//   EDGE = 16       поля экрана — те же px-4, что у пузырей сообщений
//   ICON = 32       кнопка-иконка ВНУТРИ поля; (44−32)/2 = 6 сверху и
//                   снизу, то есть она стоит по центру поля ровно
//
// Ширина на экране владельца (420pt):
//   16 + 44(адресат) + 8 + поле + 8 + 44(отправка) + 16 = 136
//   поле = 420 − 136 = 284px
//   текст в поле = 284 − 12(отступ слева) − 6(справа) − 32 − 4 − 32 = 198px
//
// Тап-зона иконок внутри поля добита до 44×44 псевдоэлементом
// (before:-inset-[6px]): визуально 32, нажимается 44 — ровно то, что
// DESIGN.md разрешает и требует.
const H = 44;
const ICON = 32;

/** «Всем» — такое же значение адресата, как имя участника, а не пропуск
    поля (28.08.2026). То же слово понимает сервер и MCP-инструмент. */
const TO_ALL = "all";

/** Файл, уже залитый на сервер, но ещё не отправленный сообщением. */
type Pending = Pick<ApiChatAttachment, "id" | "file_name">;

export function ChatComposer({
  participants,
  meId,
  fixedAddressee,
  onSend,
  sending,
  sendError,
  onHeightChange,
}: {
  participants: ApiChatParticipant[];
  meId?: string;
  /** Собеседник, которого не выбирают (28.08.2026, два канала): в разговоре
      Максима с оркестратором адресат всего один, и выбирать не из кого.
      Кнопка-робот в этом случае уступает место его лицу — слот тот же, 44px,
      геометрия строки не едет, а видно сразу, кому пишешь. */
  fixedAddressee?: ApiChatParticipant | null;
  onSend: (payload: {
    text: string;
    /** Обязателен: id участника или "all" — «всем». Пустой строки здесь
        быть не может, отправка без выбора не доходит до этого места. */
    to_user_id: string;
    attachment_ids?: string[];
  }) => Promise<void>;
  sending: boolean;
  sendError: unknown;
  /** Строка position:fixed, места в потоке не занимает — её высоту экран
      подкладывает под ленту, иначе последнее сообщение прячется под ней.
      Высота живая: чипы приложенных файлов и баннеры ошибок её меняют. */
  onHeightChange?: (px: number) => void;
}) {
  const [text, setText] = useState("");
  // "" — ещё НЕ выбран (не «всем»!), "all" — явно всем, иначе id участника.
  // Разница принципиальная: раньше пустое поле молча значило «всем», и
  // Максим не мог отличить обращение к себе от разговора мимо него.
  const [toUserId, setToUserId] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<Error | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Упоминание через @: активный «поиск» участника прямо в тексте.
  // null — mention сейчас не идёт (@ не набирали или между @ и курсором
  // появился разрыв). Иначе — позиция @, набираемый запрос и индекс
  // подсветки в дропдауне.
  const [mention, setMention] = useState<{
    start: number;
    query: string;
    selectedIndex: number;
  } | null>(null);
  // Зеркало mention в ref, чтобы обработчики клавиатуры видели актуальное
  // состояние даже между рендерами (замыкание onKeyDown живёт от прошлого
  // рендера, а setMention — отложенный).
  const mentionRef = useRef<typeof mention>(null);
  useEffect(() => {
    mentionRef.current = mention;
  }, [mention]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;
    onHeightChange(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  // ── Автодополнение @ ───────────────────────────────────────────────
  //
  // Курсор в input может переехать без правки текста (клик мышью, стрелки
  // без модификаторов), поэтому детект сидит в одном хелпере и зовётся
  // на каждом onChange. Сам mention пересоздаётся — это дёшево, стейт
  // нужен только чтобы дропдаун открылся/закрылся и сохранил позицию.
  //
  // Условие: @ засчитывается только как самостоятельный символ — в начале
  // текста или после пробельного/пунктуационного разделителя. Иначе
  // словим ложный триггер на user@example.com.
  const detectMention = (value: string, cursor: number) => {
    let i = cursor - 1;
    while (i >= 0 && /[A-Za-zА-Яа-яёЁ0-9_.-]/.test(value[i])) i--;
    if (i < 0 || value[i] !== "@") return null;
    const prev = i > 0 ? value[i - 1] : "";
    if (i !== 0 && /[A-Za-zА-Яа-яёЁ0-9_.-]/.test(prev)) return null;
    return {
      start: i,
      query: value.slice(i + 1, cursor),
      selectedIndex: mentionRef.current?.selectedIndex ?? 0,
    };
  };

  const signalTyping = useTypingSignal();

  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text: heard } = await transcribeAudio.mutateAsync(blob);
      // Расшифровка ложится В ПОЛЕ, а не уходит сразу: надиктованное почти
      // всегда хочется дописать или поправить перед отправкой.
      setText((prev) => combineDictatedText(prev, heard));
    } catch {
      // Причина уже в transcribeAudio.error — её показывает ErrorBanner.
    } finally {
      mic.finish();
    }
  });

  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    const m = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  })();

  // «Секретарь» (role=viewer, type=ai) в выбор адресата не попадает: это
  // учётка скрипта окна постановки, а не исполнитель — писать ему адресно
  // некому и незачем, отвечает он только на надиктовку в своём канале
  // (миграция 028, карточка 4396f8c9). Мёртвых пунктов в списке быть не
  // должно по той же причине, по какой в интерфейсе нет мёртвых кнопок.
  const others = participants.filter(
    (p) => p.id !== meId && !(p.role === "viewer" && p.type === "ai"),
  );
  const addressee = fixedAddressee ?? others.find((p) => p.id === toUserId);
  const toEveryone = !fixedAddressee && toUserId === TO_ALL;
  const chosen = toEveryone || !!addressee;

  // Кандидаты для @-подсказки: тот же «others» (фильтрация секретаря уже
  // сделана), но сортировка по принципу «префикс раньше подстроки» и
  // ограничение сверху. Шести пунктов хватает — в канале столько ролей
  // обычно и есть; больше — просто лишний скролл.
  const mentionCandidates = (() => {
    if (!mention) return [] as ApiChatParticipant[];
    const q = mention.query.toLowerCase();
    if (!q) return others.slice(0, 6);
    const prefix: ApiChatParticipant[] = [];
    const contains: ApiChatParticipant[] = [];
    for (const p of others) {
      const n = p.name.toLowerCase();
      if (!n.includes(q)) continue;
      (n.startsWith(q) ? prefix : contains).push(p);
    }
    return [...prefix, ...contains].slice(0, 6);
  })();

  // Если запрос сократился так, что selectedIndex вышел за список — откат
  // к первому пункту. Без этого клавиатура при нажатии вниз падала бы в
  // пустоту.
  useEffect(() => {
    if (!mention) return;
    if (mention.selectedIndex >= mentionCandidates.length) {
      setMention({ ...mention, selectedIndex: 0 });
    }
  }, [mention, mentionCandidates.length]);

  // Вставка выбранного упоминания в текст. Курсор после замены встаёт за
  // пробелом, чтобы следующий символ шёл уже после упоминания — иначе
  // продолжение набора тут же сольётся с @Имя без разрыва.
  const insertMention = (p: ApiChatParticipant) => {
    const m = mentionRef.current;
    if (!m) return;
    let cursorPos = 0;
    setText((prev) => {
      const before = prev.slice(0, m.start);
      const after = prev.slice(m.start + 1 + m.query.length);
      const insertion = `@${p.name} `;
      cursorPos = before.length + insertion.length;
      return before + insertion + after;
    });
    setMention(null);
    // Фокус и курсор — после ре-рендера, иначе setSelectionRange применится
    // к старому DOM и не подхватится.
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(cursorPos, cursorPos);
      inputRef.current?.focus();
    });
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setText(value);
    signalTyping(value.trim().length > 0);
    const cursor = e.target.selectionStart ?? value.length;
    setMention(detectMention(value, cursor));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const m = mentionRef.current;
    if (m && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((cur) =>
          cur
            ? {
                ...cur,
                selectedIndex:
                  (cur.selectedIndex + 1) % mentionCandidates.length,
              }
            : cur,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((cur) =>
          cur
            ? {
                ...cur,
                selectedIndex:
                  (cur.selectedIndex - 1 + mentionCandidates.length) %
                  mentionCandidates.length,
              }
            : cur,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[m.selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Без активного дропдауна Enter по-прежнему отправляет — это нативное
    // поведение формы, отдельный обработчик здесь не нужен.
  };

  const handlePickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const { attachment } = await uploadChatAttachment(file);
        setPending((prev) => [...prev, attachment]);
      }
    } catch (e) {
      setUploadError(e as Error);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Передумал до отправки — файл убирается и с диска сервера, чтобы
  // «ничьи» вложения не копились мусором.
  const dropPending = async (id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.delete(`/api/attachments/${id}`);
    } catch {
      // Запись уже убрана из строки — молча, показывать тут нечего.
    }
  };

  const canSend = (text.trim() || pending.length > 0) && !sending && !uploading;

  const submit = async () => {
    if (!canSend) return;
    // Адресат не выбран — не глухой отказ, а раскрытый список: кнопка,
    // которая просто не срабатывает, ничего не объясняет.
    if (!chosen) {
      setPickerOpen(true);
      return;
    }
    await onSend({
      text: text.trim(),
      to_user_id: fixedAddressee ? fixedAddressee.id : toUserId,
      attachment_ids: pending.length ? pending.map((a) => a.id) : undefined,
    });
    setText("");
    setPending([]);
    // Адресат НЕ сбрасывается: разговор обычно продолжается с тем же
    // собеседником, и переспрашивать на каждое сообщение — морока.
    // Сервер гасит отметку на самом сообщении; здесь сбрасывается счётчик
    // прореживания, иначе следующая набранная строка молчала бы до конца
    // текущего окна.
    signalTyping(false);
  };

  return (
    <div ref={rootRef} className="nt-composer">
      <ErrorBanner
        error={uploadError}
        fallback="Не удалось приложить файл"
        variant="inline"
        className="mx-4 mb-2"
      />
      <ErrorBanner
        error={sendError}
        fallback="Не удалось отправить сообщение"
        variant="inline"
        className="mx-4 mb-2"
      />
      <ErrorBanner
        error={transcribeAudio.error}
        fallback="Не удалось распознать речь"
        variant="inline"
        className="mx-4 mb-2"
      />

      {pending.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pb-2">
          {pending.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-2 px-3 h-9 rounded-lg bg-card2"
            >
              <Paperclip size={13} className="text-sub shrink-0" />
              <span className="flex-1 min-w-0 truncate text-[12px] text-text">
                {att.file_name}
              </span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => dropPending(att.id)}
                aria-label="Убрать файл"
                className="w-7 h-7 -mr-1 flex items-center justify-center text-dim"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Дропдаун @-подсказки ──────────────────────────────────────
          Стоит НАД строкой ввода, внутри того же композера — общая плёнка
          (.nt-composer::after) уже лежит под ним и под полем одновременно,
          отдельный фон не нужен. Высота композера растёт предсказуемо, и
          onHeightChange пододвигает ленту. На пустом списке не рисуется
          ничего: промахнулся мимо @ — и дропдауна нет. */}
      {mention && mentionCandidates.length > 0 && (
        <div
          role="listbox"
          aria-label="Упоминание агента"
          className="mx-4 mb-1 bg-card2 border border-stroke rounded-xl overflow-hidden shadow-lg"
        >
          {mentionCandidates.map((p, i) => {
            const selected = i === mention.selectedIndex;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertMention(p)}
                // Ховер двигает подсветку вместе с курсором: иначе
                // клавиатурная подсветка (пункт N) и мышь (пункт M) живут
                // по разным правилам, и клик «проваливается» мимо того,
                // что выделено.
                onMouseEnter={() =>
                  setMention((cur) =>
                    cur ? { ...cur, selectedIndex: i } : cur,
                  )
                }
                className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
                  selected ? "bg-card" : "bg-card2"
                }`}
              >
                <Avatar
                  initials={p.initials || p.name.slice(0, 1)}
                  color={p.avatar_color || "#A6A6A6"}
                  avatar_url={p.avatar_url}
                  size={28}
                />
                <span className="flex-1 min-w-0 truncate text-[14px] text-text">
                  {p.name}
                </span>
                {p.role && (
                  <span className="text-[11px] text-dim shrink-0">
                    {p.role}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* preventDefault на mousedown у КАЖДОЙ кнопки строки — приём из
          SubtaskFeed, и по той же причине (владелец 20.08.2026: «нажимаю
          ответить, ввожу комментарий, и он не отправляется»). Тап при
          открытой клавиатуре иначе сперва уводит фокус с поля: клавиатура
          съезжает, строка переезжает вниз — и кнопка уходит из-под пальца
          между touchstart и touchend, click не приходит вовсе. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        // gap-2 = GAP, px-4 = EDGE. items-center, а не items-end: все
        // элементы строки одного роста H, выравнивать нечего.
        className="flex items-center gap-2 px-4"
      >
        {/* Адресат один и постоянный — вместо кнопки выбора его лицо. Слот
            тот же (H×H), поэтому ширина поля и все расчёты ниже остаются
            прежними; нажимать тут нечего, и «мёртвой» кнопки, которая
            молча не срабатывает, здесь тоже нет. */}
        {fixedAddressee ? (
          <div
            style={{ width: H, height: H }}
            aria-label={`Кому: ${fixedAddressee.name}`}
            title={`Кому: ${fixedAddressee.name}`}
            className="rounded-xl bg-card2 flex items-center justify-center shrink-0"
          >
            <Avatar
              initials={fixedAddressee.initials || "?"}
              color={fixedAddressee.avatar_color || "#A6A6A6"}
              avatar_url={fixedAddressee.avatar_url}
              size={30}
            />
          </div>
        ) : (
          <>
            {/* Адресат. Был выпадающий список «Всем / имена» — владелец попросил
            иконку: «надо какого-нибудь робота своего стандартного, я нажимаю,
            всплывает окошечко, и я выбираю уже все / не все». Робот, а не
            звёздочки: звёздочки в этом интерфейсе уже значат «AI-действие», а
            здесь выбирается получатель. */}
            <button
              ref={pickerAnchorRef}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPickerOpen((v) => !v)}
              aria-label={
                addressee
                  ? `Кому: ${addressee.name}`
                  : toEveryone
                    ? "Кому: всем"
                    : "Кому? адресат не выбран"
              }
              style={{ width: H, height: H }}
              // Три состояния, и «не выбрано» отличается от «всем» видом, а не
              // только подписью: пунктир — поле ждёт заполнения, сплошной
              // акцент — адресат назван, спокойная карточка — выбраны все.
              className={`rounded-xl flex items-center justify-center shrink-0 tap-scale ${
                addressee
                  ? "bg-red text-white"
                  : toEveryone
                    ? "bg-card2 text-text"
                    : "bg-card text-red border border-dashed border-red"
              }`}
            >
              <Icon name={toEveryone ? "users" : "bot"} size={18} />
            </button>
            <ActionsMenu
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              anchorRef={pickerAnchorRef}
              items={[
                {
                  icon: toEveryone ? "check" : "users",
                  label: "Всем",
                  onClick: () => setToUserId(TO_ALL),
                },
                ...others.map((p) => ({
                  icon: toUserId === p.id ? "check" : ("bot" as const),
                  label: p.name,
                  onClick: () => setToUserId(p.id),
                })),
              ]}
            />
          </>
        )}

        {/* Поле. Рост задаётся ЯВНО (H), а не padding'ом: так он не поедет
            от смены шрифта или межстрочного и остаётся равен кнопкам. */}
        <div
          style={{ height: H }}
          className="flex-1 min-w-0 flex items-center gap-1 bg-card rounded-xl pl-3 pr-1.5"
        >
          <input
            ref={inputRef}
            value={text}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onBlur={() => {
              signalTyping(false);
              // Закрываем дропдаун с задержкой: onMouseDown на пункте
              // дропдауна успевает выставить preventDefault только если
              // blur ещё не сработал. 100 мс хватает на связку mousedown →
              // click, без неё пункт не успевает нажаться — фокус уходит
              // раньше.
              window.setTimeout(() => {
                if (mentionRef.current) setMention(null);
              }, 100);
            }}
            aria-autocomplete="list"
            aria-expanded={!!mention && mentionCandidates.length > 0}
            placeholder={
              addressee
                ? `${addressee.name}…`
                : toEveryone
                  ? "Всем…"
                  : "Кому? выбери адресата"
            }
            // 16px — не «покрупнее для красоты», а порог: на меньшем iOS
            // зумит страницу при фокусе, и экран уезжает.
            className="flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/plain,text/markdown,.doc,.docx,.odt,.ods,.xlsx"
            onChange={(e) => handlePickFiles(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Приложить файл"
            style={{ width: ICON, height: ICON }}
            // before:-inset-[6px] добивает 32 до 44 — визуально иконка
            // мелкая, нажимается по-человечески.
            className="relative rounded-lg flex items-center justify-center shrink-0 text-sub disabled:opacity-40 tap-scale before:absolute before:-inset-[6px] before:content-['']"
          >
            <Paperclip size={18} />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={mic.start}
            aria-label="Надиктовать сообщение"
            style={{ width: ICON, height: ICON }}
            className="relative rounded-lg flex items-center justify-center shrink-0 text-sub tap-scale before:absolute before:-inset-[6px] before:content-['']"
          >
            <Icon name="mic" size={18} />
          </button>
        </div>

        {/* Отправка. Была 40×40 при поле 44 — тот самый перекос. */}
        <button
          type="submit"
          onMouseDown={(e) => e.preventDefault()}
          disabled={!canSend}
          aria-label="Отправить"
          style={{ width: H, height: H }}
          className="rounded-xl bg-red flex items-center justify-center shrink-0 disabled:opacity-40 tap-scale"
        >
          <Icon name="chevron" size={18} className="text-white -rotate-90" />
        </button>
      </form>

      {(mic.state === "recording" || mic.state === "processing") && (
        <MicOverlay
          state={mic.state}
          elapsedLabel={micElapsedLabel}
          getTimeDomainData={mic.getTimeDomainData}
          onStop={mic.stop}
        />
      )}
    </div>
  );
}
