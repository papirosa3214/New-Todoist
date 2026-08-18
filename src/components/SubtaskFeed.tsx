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
// различаются формой (сплошное кольцо с галочкой vs вращающаяся комета из
// капель, см. CometSpinner ниже), не цветом. Прежнее обоснование («teal
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

// ═══ CometSpinner — «в работе» ═══
// Форма и анимация — референс Максима 18.08.2026: 12 капель по кругу, 4 из
// них горят разом — «хвост кометы» с затухающей яркостью от головы к
// хвосту, — и вращаются. Активные капли: заливка, зелёный (var(--color-
// green) через text-green), градиент прозрачности взят на глаз с самого
// референса. Неактивные — контур (не заливка, в референсе это тоже контур,
// не сплошной цвет), text-dim — та же приглушённая палитра, что у pending
// ниже. Скорость — .comet-spin в index.css, не Tailwind animate-spin
// (другая, посчитанная по кадрам референса, а не системная 1s).
const COMET_DOTS = 12;
const COMET_TAIL = 4; // сколько капель горят одновременно, включая голову
const COMET_TAIL_OPACITY = [1, 0.62, 0.34, 0.16]; // голова → хвост
// Подобрано визуально (4 варианта формы сравнены рядом при 17px и 90px,
// см. урок 2026-08-18): более широкая капля и strokeWidth 1.3 у неактивных
// давали «бублик» — контур сливался в сплошное кольцо на таком масштабе.
// Эта уже, а strokeWidth 0.6.
// Второй заход (18.08.2026): даже эта ширина (offset ±2.1 от центра) была
// шире дугового расстояния между соседними каплями (~3.9 units на радиусе
// капли) — 12 капель слипались в сплошной «цветочек» без просветов между
// лепестками. Сужена до offset ±1.3 (масштаб 0.62 по X, Y не тронут) —
// теперь между каплями есть воздух, как в референсе.
const COMET_DROP_PATH =
  "M12 8.8C11.26 8.8 10.7 7.6 10.7 6.2C10.7 4.5 11.26 2.6 12 2.6C12.74 2.6 13.3 4.5 13.3 6.2C13.3 7.6 12.74 8.8 12 8.8Z";

// active=false — «ждёт» (Максим 18.08.2026): та же капельная форма, что
// running, но неподвижная и без цветного хвоста — «цвет убери, сделай
// палочки все одним цветом, это будет стартовая позиция». Одна и та же
// иконка для обоих состояний, не два разных значка — pending читается как
// «running, только ещё не поехало», а не как что-то целиком другое (как
// было с CircleDashed раньше).
function CometSpinner({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={17}
      height={17}
      className={active ? "comet-spin" : undefined}
      aria-hidden="true"
    >
      {Array.from({ length: COMET_DOTS }, (_, i) => {
        const inTail = active && i < COMET_TAIL;
        return (
          <path
            key={i}
            d={COMET_DROP_PATH}
            transform={`rotate(${i * (360 / COMET_DOTS)} 12 12)`}
            className={inTail ? "text-green" : "text-dim"}
            fill={inTail ? "currentColor" : "none"}
            stroke={inTail ? "none" : "currentColor"}
            strokeWidth={inTail ? undefined : 0.6}
            opacity={inTail ? COMET_TAIL_OPACITY[i] : 1}
          />
        );
      })}
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
      {/* Движение — только у текущей. Под prefers-reduced-motion вращение
          гасится правилом .comet-spin в index.css, капли остаются на месте. */}
      {state === "running" && <CometSpinner active />}
      {state === "blocked" && (
        <TriangleAlert size={16} className="text-coral" />
      )}
      {/* pending — та же капельная форма, неподвижная, один цвет (см.
          CometSpinner) — не отдельная иконка. */}
      {state === "pending" && <CometSpinner active={false} />}
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
            // text-green, не text-teal — та же смена, что у CometSpinner
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
