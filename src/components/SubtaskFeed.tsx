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
import { useState } from "react";
import { Check, ChevronRight, TriangleAlert } from "lucide-react";
import { useGuardedCallback } from "../lib/useGuardedCallback";

/** Состояние подзадачи. Приходит с сервера, пока может отсутствовать. */
export type SubtaskState = "done" | "running" | "pending" | "blocked";

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
// бегущей волной, см. DashedRing ниже), не цветом. Прежнее обоснование («teal
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
};

// ═══ DashedRing — «ждёт»/«в работе» ═══
// Третий заход (18.08.2026) — предыдущие две попытки (стрелка Loader2,
// потом капли-комета) обе не понравились: комета «крутилась не как
// стрелочка на своей оси, а ещё и вокруг оси — как ураган неровный, пьяная
// стрелка». Прямая просьба: вернуть «стандартный кружок пунктирный»
// (Lucide CircleDashed) и не вращать ничего физически — вместо этого 8
// его сегментов по очереди подсвечиваются зелёным волной, «постепенно
// зажигаются пунктиры». Ничего в этой версии не двигается и не крутится:
// все 8 путей стоят на месте, меняется только их цвет по кругу — от этого
// и не может быть «пьяного» эффекта, который был у вращения группы.
// Пути скопированы 1:1 из node_modules/lucide-react/.../circle-dashed.mjs
// (не перерисованы на глаз) — pending это и есть тот самый lucide-значок,
// running — он же плюс DASH_GLOW_DURATION/8 задержка на каждый path.
const DASH_PATHS = [
  "M10.1 2.182a10 10 0 0 1 3.8 0",
  "M13.9 21.818a10 10 0 0 1-3.8 0",
  "M17.609 3.721a10 10 0 0 1 2.69 2.7",
  "M2.182 13.9a10 10 0 0 1 0-3.8",
  "M20.279 17.609a10 10 0 0 1-2.7 2.69",
  "M21.818 10.1a10 10 0 0 1 0 3.8",
  "M3.721 6.391a10 10 0 0 1 2.7-2.69",
  "M6.391 20.279a10 10 0 0 1-2.69-2.7",
];
const DASH_GLOW_DURATION = 1.6; // секунд на полный оборот волны

function DashedRing({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={17}
      height={17}
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {DASH_PATHS.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke="currentColor"
          className={active ? "text-dim dash-glow" : "text-dim"}
          style={
            active
              ? { animationDelay: `${(i * DASH_GLOW_DURATION) / 8}s` }
              : undefined
          }
        />
      ))}
    </svg>
  );
}

function StateMark({ state }: { state: SubtaskState }) {
  const v = VIEW[state];
  // Размер кружка тот же 18px, что был у чек-листа — строка не «прыгает»
  // при переходе на ленту, и высота ряда остаётся прежней.
  return (
    <div
      className={`w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0 ${v.ring}`}
      aria-label={v.label}
    >
      {/* Галочка — внутри залитого кружка, поэтому мельче поля: 12 из 18.
          У остальных кольца нет, и значок сам занимает всё место — 17px,
          чтобы кружки визуально совпадали по размеру с готовым, а не
          выглядели мелкими точками в пустоте. */}
      {state === "done" && <Check size={12} className="text-white" />}
      {/* Волна — только у текущей, ничего не вращается физически (см.
          DashedRing выше). Под prefers-reduced-motion гасится правилом
          .dash-glow в index.css, сегменты остаются на месте, без цвета. */}
      {state === "running" && <DashedRing active />}
      {state === "blocked" && (
        <TriangleAlert size={16} className="text-coral" />
      )}
      {/* pending — тот же пунктирный кружок, неподвижный (см. DashedRing) —
          не отдельная иконка. */}
      {state === "pending" && <DashedRing active={false} />}
    </div>
  );
}

function SubtaskRow({
  st,
  onToggle,
}: {
  st: FeedSubtask;
  onToggle: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const guardedToggle = useGuardedCallback(onToggle);
  const state = stateOf(st);
  const v = VIEW[state];
  const canOpen = !!st.result;

  return (
    <div>
      <div className="flex items-center gap-3 py-3 px-4">
        {/* Отметка о готовности — отдельная зона нажатия, как было раньше:
            щелчок по кружку переключает, а не раскрывает. */}
        <button
          onClick={guardedToggle}
          className="tap-scale shrink-0"
          aria-label={st.done ? "Снять отметку" : "Отметить сделанной"}
        >
          <StateMark state={state} />
        </button>

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
            {st.title}
          </span>
          {state === "running" && (
            // text-green, не text-teal — та же смена, что у DashedRing
            // выше: подпись и значок одного состояния одним цветом.
            <span className="text-[11px] text-green font-semibold shrink-0">
              {v.label}
            </span>
          )}
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
      {open && st.result && (
        <div className="pb-3 pr-4 pl-[46px] text-[13px] text-sub whitespace-pre-wrap">
          {st.result}
        </div>
      )}
    </div>
  );
}

export function SubtaskFeed({
  subtasks,
  onToggle,
}: {
  subtasks: FeedSubtask[];
  onToggle: (st: FeedSubtask) => Promise<unknown>;
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
          <SubtaskRow key={st.id} st={st} onToggle={() => onToggle(st)} />
        ))}
      </div>
    </div>
  );
}
