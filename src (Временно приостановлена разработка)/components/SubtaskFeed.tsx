// Лента подзадач вместо плоского чек-листа.
//
// Замысел Максима 15.08.2026: подзадача — не пункт списка, а самостоятельная
// единица. Её можно раскрыть и увидеть ИТОГ, текущий статус и короткий
// комментарий — но НЕ хронику: полный поток событий живёт в общей ленте
// задачи (TaskJournal), дублировать его сюда не надо. Подзадача, над которой
// агент работает прямо сейчас, отмечена движением — по доске должно быть
// видно не только «взял задачу» и «сдал», но и где он внутри неё.
//
// Образец поведения — AiTaskList.tsx из ~/Проекты/BG-CRM (состояния,
// раскрытие, живой индикатор). Взято ПОВЕДЕНИЕ; вид наш: палитра emerald/
// blue/zinc и набор иконок оттуда не переносятся, здесь токены и типографика
// TaskFlow.
//
// Данные: сервер пока отдаёт у подзадачи только `done`. Поля `state` и
// `result` объявлены необязательными и уже поддержаны — когда сервер начнёт
// их присылать, компонент менять не придётся. Пока их нет, состояние
// выводится из `done`, а раскрывать нечего — стрелка не показывается.
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Eye,
  Paperclip,
  TriangleAlert,
  X,
} from "lucide-react";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { keepAboveKeyboard } from "../lib/useVisualViewportInset";
import { MicKeyboardBar } from "./MicKeyboardBar";
import { MicOverlay } from "./MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { combineDictatedText } from "../lib/dictationParser";
import { Checkbox, ErrorBanner, Icon } from "./UI";
import { MarkdownInline } from "./MarkdownInline";
import { ActionsMenu } from "./ActionsMenu";
import { TaskControlSheet, type TaskControlKind } from "./TaskControlSheet";
import { useSubmissionReceipt } from "../api/subtasks";
import { SubmissionReceiptBadge } from "./SubmissionReceiptBadge";

/** Вложение, уже загруженное на сервер — минимум полей, нужных здесь для
    превью-чипа (не тащим сюда весь ApiAttachment ради имени файла). */
export interface PendingAttachment {
  id: string;
  file_name: string;
}

/** Состояние подзадачи. Приходит с сервера, пока может отсутствовать. */
export type SubtaskState =
  "done" | "running" | "pending" | "blocked" | "review";

export interface FeedSubtask {
  id: string;
  title: string;
  done: boolean;
  /** Появится, когда сервер научится отмечать НАЧАЛО работы, а не только конец. */
  state?: SubtaskState;
  /** Короткий «что вышло» — то, ради чего подзадачу раскрывают. */
  result?: string | null;
}

/** Состояние без гаданий: если сервер его не прислал — выводим из галочки. */
function stateOf(st: FeedSubtask): SubtaskState {
  return st.state ?? (st.done ? "done" : "pending");
}

// Цвета — только токены проекта. «В работе» раньше нарочно брала teal, а не
// зелёный (см. историю ниже) — Максим 18.08.2026 явно попросил обратное:
// прислал референс (гифка+картинка, Dropbox AI) и велел «закрась зелёненьким,
// таким же цветом как готово». Значит done и running теперь ОДНОГО цвета —
// различаются формой (сплошное кольцо с галочкой vs пунктирное кольцо с
// бегущей дугой, см. DashedRing ниже), не цветом. Прежнее обоснование («teal
// читается как активность и не спорит с red/coral») тем самым отменено этим
// прямым указанием, не забыто — оставлено в git-истории, не здесь.
//
// Кольцо рисуется ТОЛЬКО у «готово» — залитый кружок с галочкой, как было в
// чек-листе. У остальных состояний кольца нет намеренно (правка Максима
// 15.08.2026): раньше сплошная обводка сочеталась со значком внутри, и
// получалось два кольца одно в другом — пунктирный значок вставал в
// сплошной кружок криво. Теперь у не-готовых состояний виден только сам
// значок, он же и несёт форму.
const VIEW: Record<
  SubtaskState,
  { ring: string; text: string; label: string }
> = {
  done: {
    ring: "bg-green border-2 border-green",
    text: "text-sub",
    label: "готово",
  },
  running: { ring: "", text: "text-text", label: "в работе" },
  pending: { ring: "", text: "text-text", label: "ждёт" },
  blocked: { ring: "", text: "text-text", label: "упёрлась" },
  review: { ring: "", text: "text-text", label: "на проверке" },
};

// ═══ DashedRing — «ожидает» ═══
// Неподвижное пунктирное кольцо из 8 сегментов Lucide CircleDashed
// (DESIGN-SYSTEM.md §2.6, нативный `DashedRing(active: false)` в
// TFCheckbox.swift). Сегменты короче оригинальных (14° вместо ~22°, тот же
// центр каждого из 8 слотов на круге) — по просьбе «побольше промежутков
// между сегментами». До 06.10.2026 этот же компонент с `active` рисовал
// ещё и «в работе» (волна цвета по кругу); теперь «в работе» — 12 точек
// (DotsScaleRotate ниже), поэтому волна, пульсация и вращение обёртки
// отсюда и из index.css убраны, здесь осталась только форма.
const DASH_PATHS = [
  "M10.781 2.075a10 10 0 0 1 2.437 0",
  "M13.219 21.925a10 10 0 0 1 -2.437 0",
  "M18.157 4.120a10 10 0 0 1 1.723 1.723",
  "M2.075 13.219a10 10 0 0 1 0 -2.437",
  "M19.880 18.157a10 10 0 0 1 -1.723 1.723",
  "M21.925 10.781a10 10 0 0 1 0 2.437",
  "M4.120 5.843a10 10 0 0 1 1.723 -1.723",
  "M5.843 19.880a10 10 0 0 1 -1.723 -1.723",
];
function DashedRing() {
  return (
    <span className="inline-flex w-[21px] h-[21px] text-dim">
      <svg
        viewBox="0 0 24 24"
        width={21}
        height={21}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        aria-hidden="true"
      >
        {DASH_PATHS.map((d, i) => (
          <path key={i} d={d} stroke="currentColor" />
        ))}
      </svg>
    </span>
  );
}

// ═══ DotsScaleRotate — «в работе» ═══
// §2.6: у состояния «выполняется» не пунктир, а 12 точек по кругу, у
// которых голова волны полная и яркая, а хвост гаснет и уменьшается.
// Нативный `DotsScaleRotate` (TFCheckbox.swift) заменил пунктир по просьбе
// владельца 03.09.2026 — он назвал точную иконку icones/Iconify
// `svg-spinners--12-dots-scale-rotate`. Числа 1:1 с нативом: период волны
// 1.2s, точка 3.4 из 21 (здесь r≈1.9 при viewBox 24), смещение центра
// 9 из 21 (≈9.4 здесь), scale 0.35+0.65·intensity, opacity 0.2+0.8·intensity,
// где intensity = 1 − phase, phase — отставание точки от головы волны.
// Зависимость линейная, поэтому кейфрейм в index.css линейный, а бег волны
// по кругу задаётся отрицательным animation-delay по индексу точки.
const DOTS_COUNT = 12;
const DOTS_PERIOD = 1.2;

function DotsScaleRotate() {
  return (
    <span className="inline-flex w-[21px] h-[21px] text-text">
      <svg viewBox="0 0 24 24" width={21} height={21} aria-hidden="true">
        {Array.from({ length: DOTS_COUNT }, (_, i) => (
          <g key={i} transform={`rotate(${(i * 360) / DOTS_COUNT} 12 12)`}>
            <circle
              className="dots-scale-rotate"
              cx={12}
              cy={2.6}
              r={1.9}
              fill="currentColor"
              style={{
                animationDelay: `${(-i * DOTS_PERIOD) / DOTS_COUNT}s`,
              }}
            />
          </g>
        ))}
      </svg>
    </span>
  );
}

function StateMark({ state }: { state: SubtaskState }) {
  const v = VIEW[state];
  // Кружок был 18px (тот же, что у чек-листа) — вырос до 21px вслед за
  // DashedRing (просьба «побольше промежутков между сегментами» потянула
  // и общий размер значка). Общий для всех состояний, чтобы строка не
  // «прыгала» между ними.
  return (
    <div
      className={`w-[21px] h-[21px] rounded-full flex items-center justify-center shrink-0 ${v.ring}`}
      aria-label={v.label}
    >
      {/* Галочка — внутри залитого кружка, поэтому мельче поля: 12 из 21.
          У остальных кольца нет, и значок сам занимает всё место — 21px,
          чтобы кружки визуально совпадали по размеру с готовым, а не
          выглядели мелкими точками в пустоте. */}
      {state === "done" && <Check size={12} className="text-white" />}
      {/* Точки — только у текущей; под prefers-reduced-motion волна
          гасится правилом .dots-scale-rotate в index.css, точки остаются
          неподвижным кольцом (см. DotsScaleRotate выше). */}
      {state === "running" && <DotsScaleRotate />}
      {/* text-orange, не text-coral (18.08.2026, найден рассинхрон) —
          «заблокировано» и в AgentStatusRow (статус самой задачи наверху),
          и здесь должно быть ОДНИМ цветом. Coral — это «Агент пропал»
          (агент молчит дольше 15 минут, требует внимания острее, чем
          обычная блокировка), не «упёрлась»; их нельзя красить одинаково. */}
      {state === "blocked" && (
        <TriangleAlert size={21} className="text-orange" />
      )}
      {/* review — text-blue, тот же цвет, что «На проверке — ждёт вашей
          приёмки» в AgentStatusRow наверху (18.08.2026, новое состояние):
          агент сдал шаг, ждёт вашего решения — принять (галочка) или
          вернуть на доработку (см. владельческие действия ниже). */}
      {state === "review" && <Eye size={21} className="text-blue" />}
      {/* pending — пунктирный кружок из 8 сегментов, неподвижный
          (см. DashedRing) — не отдельная иконка. */}
      {state === "pending" && <DashedRing />}
    </div>
  );
}

// Форма ответа — общая для двух сценариев (18.08.2026): «Вернуть» у review
// (комментарий + возврат в pending) и «Ответить» у blocked (просто
// комментарий, без смены state — агент сам снимает блокировку, когда
// сможет). Файл — та же инфраструктура вложений, что у обычного
// комментария задачи (TaskDetailScreen): грузится сразу при выборе, чипом
// висит над полем, можно убрать до отправки.
function ReplyForm({
  placeholder,
  busy,
  onUploadFile,
  onCancel,
  onSubmit,
}: {
  placeholder: string;
  busy: boolean;
  onUploadFile?: (file: File) => Promise<PendingAttachment>;
  onCancel: () => void;
  onSubmit: (comment: string, attachmentIds: string[]) => Promise<unknown>;
}) {
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Форма разворачивается ВНУТРИ уже прокрученной ленты, часто при уже
  // открытой клавиатуре — тогда autoFocus доводит поле до низа экрана, то
  // есть ровно под клавиатуру. Поднимаем сами. Второй заход с задержкой —
  // на случай, когда клавиатура только выезжает: к этому моменту --kb-inset
  // уже настоящий.
  useEffect(() => {
    keepAboveKeyboard(fieldRef.current);
    const t = setTimeout(() => keepAboveKeyboard(fieldRef.current), 350);
    return () => clearTimeout(t);
  }, []);

  // Микрофон — тот же приём, что у поля комментария в ленте и у шторки
  // «Ответить агенту»/«Вернуть на доработку» (TaskJournal.tsx): владелец
  // 20.08.2026 про эту самую форму, ответ на заблокированный шаг —
  // «нативная клавиатура — пропадает мой микрофончик». Свой независимый
  // recorder-инстанс, не общий с TaskDetailScreen/TaskJournal: каждый
  // держит свой getUserMedia-поток только пока реально пишет, и работать
  // одновременно в двух местах пользователь физически не может — заметный
  // конфликт был бы только если один поток ещё не отпущен (IDLE_RELEASE_MS
  // = 2 мин), а запись начата в другом месте; отдельный вопрос, если
  // всплывёт на практике.
  const [focused, setFocused] = useState(true);
  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text } = await transcribeAudio.mutateAsync(blob);
      setComment((prev) => combineDictatedText(prev, text));
    } catch {
      // Причина уже в transcribeAudio.error — её показывает ErrorBanner.
    } finally {
      mic.finish();
    }
  });
  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  })();

  const guardedSubmit = useGuardedCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    await onSubmit(
      trimmed,
      pending.map((a) => a.id),
    );
  });

  const handlePickFiles = async (files: FileList | null) => {
    if (!files?.length || !onUploadFile) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const att = await onUploadFile(file);
        setPending((prev) => [...prev, att]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {pending.length > 0 && (
        <div className="flex flex-col gap-1">
          {pending.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-2 px-3 h-9 rounded-lg bg-card2"
            >
              <Paperclip size={13} className="text-sub shrink-0" />
 <span className="tf-meta flex-1 min-w-0 truncate text-text">
                {att.file_name}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPending((prev) => prev.filter((a) => a.id !== att.id))
                }
                aria-label="Убрать файл"
                className="w-7 h-7 -mr-1 flex items-center justify-center text-dim"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <ErrorBanner
        error={transcribeAudio.error}
        fallback="Не удалось распознать речь. Проверьте соединение."
        variant="block"
        className="mb-1"
      />
      <textarea
        ref={fieldRef}
        autoFocus
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onFocus={() => setFocused(true)}
        // Та же задержка, что у поля комментария в ленте и у шторки
        // задачи: клик по микрофону не крадёт фокус (MicKeyboardBar гасит
        // mousedown), но blur всё равно приходит раньше её onClick.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={placeholder}
 className="tf-row w-full bg-card2 rounded-xl px-3 py-2 text-text placeholder:text-dim outline-none resize-none"
      />
      {/* preventDefault на mousedown — тот же приём, что в MicKeyboardBar, и
          по той же причине, только здесь он был пропущен. Тап по кнопке при
          открытой клавиатуре сперва уводит фокус с textarea: клавиатура
          съезжает, страница вырастает обратно, и кнопка УЕЗЖАЕТ из-под пальца
          между touchstart и touchend. click в этом случае не приходит вовсе —
          нажатие просто теряется. Владелец 20.08.2026: «нажимаю ответить,
          ввожу комментарий, и он не отправляется».
          Сюда же вторая половина жалобы, «сообщение просто исчезает»: после
          первого потерянного нажатия макет уже сдвинут, и повторный тап по
          тому же месту приходится на соседнюю «Отмену» — форма закрывается
          вместе с набранным текстом. Поэтому гасится mousedown у ВСЕХ трёх
          кнопок строки, а не только у «Отправить»: фокус не уходит — макет не
          прыгает — промахнуться некуда.
          type="button" обязателен: по умолчанию у button тип submit, и стоит
          этой форме однажды оказаться внутри <form>, как нажатие начнёт
          перезагружать страницу. */}
      <div className="flex items-center gap-3">
        {onUploadFile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/plain,.doc,.docx,.odt,.ods,.xlsx"
              onChange={(e) => handlePickFiles(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Приложить файл"
              className="w-9 h-9 -ml-1.5 rounded-lg flex items-center justify-center shrink-0 disabled:opacity-50"
            >
              <Paperclip size={16} className="text-sub" />
            </button>
          </>
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={guardedSubmit}
          disabled={!comment.trim() || busy || uploading}
 className="tf-action text-blue disabled:opacity-40 tap-fade"
        >
          Отправить
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
 className="tf-action text-dim tap-fade"
        >
          Отмена
        </button>
      </div>
      {focused && mic.state === "idle" && (
        <MicKeyboardBar
          onStart={mic.start}
          ariaLabel="Надиктовать ответ на шаг"
        />
      )}
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

function SubtaskRow({
  st,
  isOwner,
  onToggle,
  onReturn,
  onComment,
  onUploadFile,
}: {
  st: FeedSubtask;
  isOwner: boolean;
  onToggle: () => Promise<unknown>;
  onReturn?: (comment: string, attachmentIds: string[]) => Promise<unknown>;
  onComment?: (comment: string, attachmentIds: string[]) => Promise<unknown>;
  onUploadFile?: (file: File) => Promise<PendingAttachment>;
  // «Прервать шаг» / «Сбросить попытку» (MAK-69) не требуют колбэков в
  // SubtaskRow: шторка причины TaskControlSheet открывается здесь через
  // локальный useState, а саму мутацию шлёт TaskControlSheet напрямую
  // через useCancelSubtask/useResetSubtask. Раньше пропсы
  // onServerCancel/onServerReset сюда тянулись по инерции первой спеки
  // дизайнера, но TaskControlSheet сама является клиентом API — и
  // дополнительная прослойка только размывает «кто отправляет запрос».
}) {
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const guardedToggle = useGuardedCallback(onToggle);
  const state = stateOf(st);
  const v = VIEW[state];
  // «Сдача основным TaskFlow» — отдельная строка под result, чтобы статус
  // подтверждения читался независимо от текста исполнителя (карточка
  // 8aa62aea, шаг receipt_web). Тянем за subtask.id, общий на всё дерево.
  // enabled=false для шагов без done: receipt.confirmed имеет смысл только
  // когда сервер уже готов признать закрытие, чтобы не плодить лишние
  // 404-запросы на черновиках.
  const showReceipt = state === "done";
  const receiptQuery = useSubmissionReceipt(showReceipt ? st.id : null);
  const receipt = receiptQuery.data;
  const receiptError = receiptQuery.error;
  const receiptLoading = receiptQuery.isLoading;
  // blocked без result всё равно должен раскрываться — там форма ответа,
  // а не итог: агент не обязан передавать result вместе с blocked (только
  // review требует его на сервере).
  const canOpen = !!st.result || state === "blocked";
  // Вернуть — только владелец, только пока шаг реально на проверке
  // (18.08.2026, симметрично AgentOwnerActions на уровне задачи).
  const canReturn = isOwner && state === "review" && !!onReturn;
  // Ответить на блокировку — тот же принцип, другое действие: не меняет
  // state (агент сам решает, когда разблокировался), просто комментарий
  // в общую ленту задачи, чтобы не листать вниз в поисках поля ввода
  // (18.08.2026, прямая просьба).
  const canComment = isOwner && state === "blocked" && !!onComment;
  // «Прервать шаг» — есть живой run, который надо дёрнуть через
  // run.abort(); запрещено у done/pending: прерывать нечего. По спеке
  // ec109e74.
  const canServerCancel =
    isOwner && (state === "running" || state === "blocked" || state === "review");
  // «Сбросить попытку» — есть current_attempt_id (предполагаем, что
  // сервер снимет его при любом завершении, см. control.ts:81-86,
  // 121-127). Точечный сценарий: процесс уже умер, а lease ещё не
  // истёк. По спеке ec109e74.
  const canServerReset = isOwner && state !== "done" && state !== "pending";
  // Меню «три точки» появляется, только если есть ХОТЬ ОДНО серверное
  // действие — иначе кнопку рисовать незачем (она была бы мёртвой зоной
  // нажатия).
  const showServerMenu = isOwner && (canServerCancel || canServerReset);
  const [dotsOpen, setDotsOpen] = useState(false);
  const dotsAnchorRef = useRef<HTMLDivElement | null>(null);
  // kind шторки — один экземпляр TaskControlSheet, что живёт в
  // SubtaskRow: после клика на пункт меню поднимается соответствующий
  // kind; null — шторка закрыта.
  const [controlKind, setControlKind] = useState<TaskControlKind | null>(null);

  const submitReturn = async (comment: string, attachmentIds: string[]) => {
    if (!onReturn) return;
    setBusy(true);
    try {
      await onReturn(comment, attachmentIds);
      setReplying(false);
    } finally {
      setBusy(false);
    }
  };
  const submitComment = async (comment: string, attachmentIds: string[]) => {
    if (!onComment) return;
    setBusy(true);
    try {
      await onComment(comment, attachmentIds);
      setReplying(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 py-3 px-4">
        {/* Отметка о готовности — отдельная зона нажатия, как было раньше:
            щелчок по кружку переключает, а не раскрывает. Кроме review
            (18.08.2026, прямое указание): «на проверке» — решение
            («Принять»/«Вернуть»), не тап-переключатель — та же зона
            нажатия, что и раньше, случайным щелчком легко принять шаг,
            который на самом деле хотели отклонить. Приёмка теперь только
            явной кнопкой в раскрытом виде ниже. */}
        {state === "review" && st.state !== undefined ? (
          <div className="shrink-0" aria-label={v.label}>
            <StateMark state={state} />
          </div>
        ) : (
          // Тап-зона 44×44 (§2.6 / §Layout): сам кружок 21×21, но
          // нажимаемая область — не меньше HIG. Отрицательные поля
          // (44−21)/2 = 11.5 компенсируют её в потоке, поэтому кромка
          // кружка и начало заголовка остаются на прежних местах.
          <button
            onClick={guardedToggle}
            className="tap-scale -m-[11.5px] w-11 h-11 shrink-0 inline-flex items-center justify-center"
            aria-label={st.done ? "Снять отметку" : "Отметить сделанной"}
          >
            {st.state === undefined ? (
              <Checkbox checked={st.done} />
            ) : (
              <StateMark state={state} />
            )}
          </button>
        )}

        {/* Заголовок раскрывает подзадачу — но только если внутри есть итог.
            Кнопка без содержимого хуже отсутствующей: нажимаешь, ничего не
            происходит. */}
        <button
          onClick={() => canOpen && setOpen((o) => !o)}
          disabled={!canOpen}
          className={`flex-1 min-w-0 flex items-center gap-2 text-left ${canOpen ? "tap-fade" : ""}`}
        >
          <span
 className={`tf-row flex-1 min-w-0 ${state ==="done" ?"line-through" :""} ${v.text}`}
          >
            <MarkdownInline source={st.title} />
          </span>
          {/* Текстовая подпись «в работе» рядом с заголовком убрана
              (18.08.2026, прямое указание) — избыточна: статус самой
              задачи уже написан выше (AgentStatusRow, «Агент работает»),
              а DashedRing здесь же сигнализирует состояние формой и
              движением. v.label остаётся только в aria-label кружка
              (доступность), не в видимом тексте. */}
          {canOpen && (
            <ChevronRight
              size={16}
              className={`text-dim shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
          )}
        </button>
        {/* «Три точки» — серверные действия (MAK-69). Рисуются ТОЛЬКО
            владельцу и ТОЛЬКО если есть живой run или попытка для
            сброса (см. canServerCancel/canServerReset выше). Размещены
            ПОСЛЕ блока заголовка — отдельной группой иконок, чтобы не
            путать «комментировать агенту» с «прервать шаг»: та же
            визуальная логика, что у кнопки «три точки» в шапке чата. */}
        {showServerMenu && (
          <div
            ref={dotsAnchorRef}
            className="flex items-center gap-1 shrink-0"
          >
            <button
              type="button"
              onClick={() => setDotsOpen((o) => !o)}
              aria-label="Управление шагом"
              className="tap-scale w-10 h-10 flex items-center justify-center text-dim"
            >
              <Icon name="dotsH" size={18} />
            </button>
            <ActionsMenu
              open={dotsOpen}
              onClose={() => setDotsOpen(false)}
              anchorRef={dotsAnchorRef}
              items={[
                ...(canServerCancel
                  ? [
                      {
                        icon: "power",
                        label: "Прервать шаг",
                        destructive: true,
                        onClick: () => {
                          setDotsOpen(false);
                          setControlKind("cancel_subtask");
                        },
                      },
                    ]
                  : []),
                ...(canServerReset
                  ? [
                      {
                        icon: "refresh",
                        label: "Сбросить попытку",
                        onClick: () => {
                          setDotsOpen(false);
                          setControlKind("reset_subtask");
                        },
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        )}
      </div>

      {/* Шторка причины для серверных действий на этой подзадаче. Один
          экземпляр TaskControlSheet с kind-стейтом: открывается с
          соответствующим kind, после успеха мутации снимается (см.
          useEffect внутри TaskControlSheet). */}
      {controlKind && (
        <TaskControlSheet
          open={controlKind !== null}
          onClose={() => setControlKind(null)}
          kind={controlKind}
          subtaskId={st.id}
        />
      )}

      {/* Итог — то, ради чего подзадачу открывают. Отступ слева равен
          кружку (18px) плюс зазору (12px), чтобы текст шёл по одной
          вертикали с заголовком, а не висел под кружком. */}
      {open && (
        <div className="pb-3 pr-4 pl-[46px]">
          {st.result && (
 <p className="tf-action text-sub whitespace-pre-wrap">
              {st.result}
            </p>
          )}
          {/* Квитанция сдачи основным TaskFlow — отдельно от result, чтобы
              статус подтверждения не зависел от того, что написал исполнитель
              (карточка 8aa62aea, шаг receipt_web). Рисуем у закрытых шагов:
              черновикам квитанция не нужна. */}
          {showReceipt && (
            <SubmissionReceiptBadge
              receipt={receipt}
              error={receiptError}
              loading={receiptLoading}
            />
          )}
          {/* Приёмка шага владельцем — обе кнопки рядом, в одной строке
              (18.08.2026, прямое указание): кружок выше больше не кликается
              у review (см. правку там же) — случайный тап по нему раньше
              мог принять шаг, который хотели отклонить. Явное решение,
              не тап-переключатель. Инлайн, не bottom-sheet как у задачи
              целиком: подзадача уже раскрыта на этом же месте. */}
          {canReturn && !replying && (
            <div className="mt-2 flex justify-between">
              <button
                onClick={guardedToggle}
 className="tf-action uppercase tracking-wider text-green tap-fade"
              >
                Принять
              </button>
              <button
                onClick={() => setReplying(true)}
 className="tf-action uppercase tracking-wider text-blue tap-fade"
              >
                Вернуть
              </button>
            </div>
          )}
          {canReturn && replying && (
            <ReplyForm
              placeholder="Что нужно поправить…"
              busy={busy}
              onUploadFile={onUploadFile}
              onCancel={() => setReplying(false)}
              onSubmit={submitReturn}
            />
          )}
          {/* Ответ на блокировку — сразу форма, без промежуточной кнопки
              (в отличие от review, тут нет второго действия вроде
              «Принять», выбирать не из чего). */}
          {canComment && !replying && (
            <button
              onClick={() => setReplying(true)}
 className="tf-action mt-2 uppercase tracking-wider text-orange tap-fade"
            >
              Ответить
            </button>
          )}
          {canComment && replying && (
            <ReplyForm
              placeholder="Например: доступ уже дал, попробуй ещё раз…"
              busy={busy}
              onUploadFile={onUploadFile}
              onCancel={() => setReplying(false)}
              onSubmit={submitComment}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function SubtaskFeed({
  subtasks,
  isOwner = false,
  onToggle,
  onReturn,
  onComment,
  onUploadFile,
}: {
  subtasks: FeedSubtask[];
  /** Кнопки «Принять»/«Вернуть»/«Ответить» видны владельцу задачи —
      TaskDetailScreen передаёт isTaskOwner(currentUser, task): создатель
      ИЛИ владелец трекера (lib/taskOwner.ts). До 18.08.2026 сравнивался
      только creator_id, и у задачи, заведённой агентом, принимать работу
      было некому. Без этого пропа (форма редактирования и т.п.) кнопки
      просто не рисуются. */
  isOwner?: boolean;
  onToggle: (st: FeedSubtask) => Promise<unknown>;
  /** review → pending, с комментарием и вложениями (18.08.2026). */
  onReturn?: (
    st: FeedSubtask,
    comment: string,
    attachmentIds: string[],
  ) => Promise<unknown>;
  /** blocked — просто ответ в общую ленту, state не меняется. */
  onComment?: (
    st: FeedSubtask,
    comment: string,
    attachmentIds: string[],
  ) => Promise<unknown>;
  onUploadFile?: (file: File) => Promise<PendingAttachment>;
  // «Прервать шаг» / «Сбросить попытку» (MAK-69) живут ВНУТРИ SubtaskRow:
  // TaskControlSheet сама шлёт мутацию через useCancelSubtask/
  // useResetSubtask. Пробрасывать колбэки через SubtaskFeed не нужно —
  // только размывает «кто отправляет запрос».
}) {
  if (subtasks.length === 0) return null;

  const готово = subtasks.filter((s) => stateOf(s) === "done").length;

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-2 px-1">
 <h3 className="tf-action text-sub ">Подзадачи</h3>
        {/* Счётчик вместо полосы прогресса: цифра точнее и занимает
            строку, которая и так есть. */}
 <span className="tf-meta text-dim">
          {готово} из {subtasks.length}
        </span>
      </div>
      <div className="bg-card rounded-2xl overflow-hidden divide-y divide-stroke">
        {subtasks.map((st) => (
          <SubtaskRow
            key={st.id}
            st={st}
            isOwner={isOwner}
            onToggle={() => onToggle(st)}
            onReturn={
              onReturn
                ? (comment, ids) => onReturn(st, comment, ids)
                : undefined
            }
            onComment={
              onComment
                ? (comment, ids) => onComment(st, comment, ids)
                : undefined
            }
            onUploadFile={onUploadFile}
          />
        ))}
      </div>
    </div>
  );
}
