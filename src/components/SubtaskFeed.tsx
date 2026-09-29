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
import { ErrorBanner } from "./UI";
import { MarkdownInline } from "./MarkdownInline";

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

// ═══ DashedRing — «ждёт»/«в работе» ═══
// Пятый заход (18.08.2026). Четвёртая версия (дуга 5 из 8 сегментов) была
// на верной идее, но с багом: animation-delay назначался по ИНДЕКСУ path в
// массиве Lucide, а индекс НЕ совпадает с угловым положением сегмента на
// круге (пути в circle-dashed.mjs перечислены в порядке генерации SVG, не
// по часовой стрелке) — волна зажигала сегменты вразнобой, «в трёх
// абсолютно разных местах» вместо соседних. Никакого transform тут нет и
// не было ни в одной версии DashedRing — 8 путей стоят на месте всегда,
// меняется только их color, поэтому в принципе неоткуда взяться «сходу с
// оси»: ось есть только у вращения группы (та самая забракованная комета),
// не у смены цвета неподвижных штрихов.
//
// Исправление — не на глаз: посчитан скриптом (atan2 от центра 12,12 до
// стартовой точки M каждого path) реальный угол каждого из 8 сегментов,
// шаг подтверждён ровно 45° между соседями. DASH_ANGULAR_POSITION[i] —
// позиция path[i] в этом угловом порядке по часовой стрелке (0..7), а не
// его индекс в массиве. Задержка анимации назначается по этой позиции —
// теперь горящая дуга физически идёт по соседним сегментам круга.
//
// Дуги короче оригинальных Lucide (14° вместо ~22°, тот же центр каждого
// из 8 слотов на круге) — по прямой просьбе «побольше промежутков между
// сегментами». Пересчитаны тем же скриптом (те же 8 угловых позиций, новый
// span), не подрисованы на глаз — DASH_ANGULAR_POSITION ниже не поменялся,
// потому что центр каждого сегмента остался тем же, поменялась только его
// длина. Проверено покадрово (Playwright, 8 кадров одного цикла) перед
// переносом сюда — дуга из 5 идёт по кругу без скачков.
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
// угловой порядок по часовой (расчёт): [2,5,4,1,7,3,6,0] — инвертирован
// в позицию по индексу массива ниже. Цветовая волна («змейка») идёт по
// часовой (прямая просьба Максима 18.08.2026) — отдельно от физического
// вращения всей обёртки (dash-spin в index.css), которое идёт против
// часовой: это два независимых слоя движения в разные стороны, не опечатка.
const DASH_ANGULAR_POSITION = [7, 3, 0, 5, 2, 1, 6, 4];
// Цвет («змейка») быстрее, чем физическое вращение круга (0.8s vs 1.6s
// у dash-spin в index.css, прямая просьба Максима 18.08.2026) — держать
// оба числа согласованными при правке любого из двух мест.
const DASH_GLOW_DURATION = 0.8;

function DashedRing({ active }: { active: boolean }) {
  // Вращение и пульсация — обе transform, поэтому на разных узлах: одна
  // CSS-анимация transform на элементе перезаписывала бы другую, а не
  // складывалась с ней. dash-spin — на обёртке (весь кружок физически
  // крутится, против часовой), dash-pulse — на самом svg внутри неё
  // (дышит размером). Обёртка ровно 21×21 без отступов, чтобы её
  // transform-origin:center совпадал с геометрическим центром SVG —
  // иначе вращение шло бы по орбите вокруг чужой точки, а не своей оси
  // (та самая «пьяная стрелка», которую раскритиковали у кометы). Здесь
  // риска нет: фигура симметрична (8 сегментов через равные 45°), а не
  // как у кометы — разномастная группа капель.
  return (
    <span
      className={`inline-flex w-[21px] h-[21px] ${active ? "dash-spin" : ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        width={21}
        height={21}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        aria-hidden="true"
        className={active ? "dash-pulse" : undefined}
      >
        {DASH_PATHS.map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="currentColor"
            className={active ? "text-dim dash-glow" : "text-dim"}
            style={
              active
                ? {
                    animationDelay: `${(DASH_ANGULAR_POSITION[i] * DASH_GLOW_DURATION) / 8}s`,
                  }
                : undefined
            }
          />
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
      {/* Дуга — только у текущей, ничего не вращается физически (см.
          DashedRing выше). Под prefers-reduced-motion гасится правилом
          .dash-glow в index.css, сегменты остаются на месте, без цвета. */}
      {state === "running" && <DashedRing active />}
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
      {/* pending — тот же пунктирный кружок, неподвижный (см. DashedRing) —
          не отдельная иконка. */}
      {state === "pending" && <DashedRing active={false} />}
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
              <span className="flex-1 min-w-0 truncate text-[12px] text-text">
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
        className="w-full bg-card2 rounded-xl px-3 py-2 text-[14px] text-text placeholder:text-dim outline-none resize-none"
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
          className="text-[13px] font-semibold text-blue disabled:opacity-40 tap-fade"
        >
          Отправить
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
          className="text-[13px] text-dim tap-fade"
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
}) {
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const guardedToggle = useGuardedCallback(onToggle);
  const state = stateOf(st);
  const v = VIEW[state];
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
        {state === "review" ? (
          <div className="shrink-0" aria-label={v.label}>
            <StateMark state={state} />
          </div>
        ) : (
          <button
            onClick={guardedToggle}
            className="tap-scale shrink-0"
            aria-label={st.done ? "Снять отметку" : "Отметить сделанной"}
          >
            <StateMark state={state} />
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
            className={`flex-1 min-w-0 text-[14px] ${state === "done" ? "line-through" : ""} ${v.text}`}
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
      </div>

      {/* Итог — то, ради чего подзадачу открывают. Отступ слева равен
          кружку (18px) плюс зазору (12px), чтобы текст шёл по одной
          вертикали с заголовком, а не висел под кружком. */}
      {open && (
        <div className="pb-3 pr-4 pl-[46px]">
          {st.result && (
            <p className="text-[13px] text-sub whitespace-pre-wrap">
              {st.result}
            </p>
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
                className="text-[13px] font-semibold uppercase tracking-wider text-green tap-fade"
              >
                Принять
              </button>
              <button
                onClick={() => setReplying(true)}
                className="text-[13px] font-semibold uppercase tracking-wider text-blue tap-fade"
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
              className="mt-2 text-[13px] font-semibold uppercase tracking-wider text-orange tap-fade"
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
}) {
  if (subtasks.length === 0) return null;

  const готово = subtasks.filter((s) => stateOf(s) === "done").length;

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-2 px-1">
        <h3 className="text-[13px] text-sub font-semibold">Подзадачи</h3>
        {/* Счётчик вместо полосы прогресса: цифра точнее и занимает
            строку, которая и так есть. */}
        <span className="text-[12px] text-dim">
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
