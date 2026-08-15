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
import {
  Check,
  ChevronRight,
  CircleDashed,
  Loader2,
  TriangleAlert,
} from "lucide-react";
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

// Цвета — только токены проекта. Синего среди них нет, «в работе» берёт
// teal: он читается как активность и не спорит с red (приоритет) и
// coral (тревога).
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
          гасится глобальным правилом в index.css, значок остаётся. */}
      {state === "running" && (
        <Loader2 size={17} className="text-teal animate-spin" />
      )}
      {state === "blocked" && (
        <TriangleAlert size={16} className="text-coral" />
      )}
      {state === "pending" && <CircleDashed size={17} className="text-dim" />}
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
            <span className="text-[11px] text-teal font-semibold shrink-0">
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
