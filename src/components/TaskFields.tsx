// Shared task-editing field primitives used by TaskFormScreen (create AND
// edit — the same form component, see that file) and, for read-only
// display, by TaskDetailScreen. Built to match the "Новая задача" screen in
// mockup-reference/index.html (id="s-newtask", lines 1112–1201): a `.card`
// of `.row`s for Срок/Проект/Приоритет, a horizontally-tagged `.card` for
// Метки, and a `.card` add-row for Подзадачи. The mockup has no dedicated
// task-detail screen and no date/priority/label picker sheet, so the
// expand-in-place picker panels below (calendar, priority list, label
// create-row) follow the interaction pattern already accepted for the task
// form rather than inventing a modal.
import { useState, Children, type ReactNode } from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { Icon } from "./UI";
import { formatDueLabel, todayStr, tomorrowStr } from "../lib/date";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { PRIORITIES } from "../lib/priority";
import type { ApiLabel } from "../api/types";

// Re-exported so existing `import { PRIORITIES } from "../components/TaskFields"`
// call sites (TaskDetailScreen) keep working. ../lib/priority.ts is the
// canonical source now — see PRIORITY_COLORS/getPriorityColor there for
// the flat color-only form (for screens that just need a dot's color, not
// the full label/name/color metadata).
export { PRIORITIES };

// ═══════════ CARD (mockup .card — 14px radius, edge-to-edge dividers) ═══════════

export function Card({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      {items.map((child, i) => (
        <div key={i} className={i > 0 ? "border-t border-stroke" : ""}>
          {child}
        </div>
      ))}
    </div>
  );
}

// ═══════════ FIELD ROW (mockup .row — r-ic / r-tx / r-val / r-chev) ═══════════

export function FieldRow({
  icon,
  iconClassName = "text-sub",
  label,
  value,
  valueClassName = "text-sub",
  trailing,
  chevron = true,
  chevronOpen = false,
  onClick,
  minHeight = 48,
}: {
  icon?: string;
  iconClassName?: string;
  label: string;
  value?: ReactNode;
  valueClassName?: string;
  trailing?: ReactNode;
  chevron?: boolean;
  chevronOpen?: boolean;
  onClick?: () => void;
  minHeight?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 text-left active:bg-white/[0.04] transition-colors"
      style={{ minHeight }}
    >
      {icon && (
        <Icon name={icon} size={18} className={`shrink-0 ${iconClassName}`} />
      )}
      <span className="text-[15px] font-medium text-text flex-1 min-w-0 truncate">
        {label}
      </span>
      {value !== undefined && (
        <span
          className={`text-[14px] shrink-0 ${typeof value === "string" ? valueClassName : ""}`}
        >
          {value}
        </span>
      )}
      {trailing}
      {chevron && (
        <Icon
          name={chevronOpen ? "chevronDown" : "chevron"}
          size={14}
          className="text-dim shrink-0"
        />
      )}
    </button>
  );
}

// ═══════════ PRIORITY ═══════════
// (PRIORITIES itself now lives in ../lib/priority.ts — imported + re-exported above.)

// mockup .p1-pill
export function PriorityPill({ priority }: { priority: number }) {
  const p = PRIORITIES.find((x) => x.key === priority) ?? PRIORITIES[3];
  return (
    <span
      className="inline-flex items-center justify-center text-[11px] font-bold text-white rounded-[10px] px-2 h-[20px] min-w-[26px] shrink-0"
      style={{ backgroundColor: p.color }}
    >
      {p.label}
    </span>
  );
}

export function PriorityField({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FieldRow
        icon="flag"
        label="Приоритет"
        value={<PriorityPill priority={value} />}
        chevronOpen={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="border-t border-stroke">
          {PRIORITIES.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                onChange(p.key);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-white/[0.04] transition-colors"
            >
              <span
                className="w-[24px] h-[24px] rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                style={{ backgroundColor: p.color }}
              >
                {p.label}
              </span>
              <span className="text-[14px] text-text flex-1">{p.name}</span>
              {p.key === value && (
                <Icon name="check" size={16} className="text-red shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ═══════════ DUE DATE ═══════════

function miniCal(year: number, month: number) {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
}

const CAL_MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

export function DueDateField({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const base = value
    ? new Date(value + "T00:00:00")
    : new Date(todayStr() + "T00:00:00");
  const [calYear, setCalYear] = useState(base.getFullYear());
  const [calMonth, setCalMonth] = useState(base.getMonth());

  const cells = miniCal(calYear, calMonth);
  const today = todayStr();
  const tomorrow = tomorrowStr();
  const hasValue = !!value;

  return (
    <>
      <FieldRow
        icon="calendarSmall"
        iconClassName={hasValue ? "text-red" : "text-sub"}
        label="Срок"
        value={hasValue ? formatDueLabel(value!) : "Не установлен"}
        valueClassName={hasValue ? "text-red" : "text-sub"}
        chevronOpen={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="border-t border-stroke px-3 py-3">
          {/* Быстрые опции */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => {
                onChange(today);
                setOpen(false);
              }}
              className={`flex-1 h-[40px] rounded-xl text-[13px] font-medium transition-colors ${
                value === today
                  ? "bg-red text-white"
                  : "bg-card2 text-text active:bg-white/10"
              }`}
            >
              Сегодня
            </button>
            <button
              onClick={() => {
                onChange(tomorrow);
                setOpen(false);
              }}
              className={`flex-1 h-[40px] rounded-xl text-[13px] font-medium transition-colors ${
                value === tomorrow
                  ? "bg-red text-white"
                  : "bg-card2 text-text active:bg-white/10"
              }`}
            >
              Завтра
            </button>
          </div>

          {/* Календарь для произвольной даты */}
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() =>
                calMonth === 0
                  ? (setCalMonth(11), setCalYear(calYear - 1))
                  : setCalMonth(calMonth - 1)
              }
              className="p-1.5 -m-1.5"
            >
              <Icon name="chevronLeft" size={16} className="text-sub" />
            </button>
            <span className="text-[13px] font-semibold">
              {CAL_MONTHS[calMonth]} {calYear}
            </span>
            <button
              onClick={() =>
                calMonth === 11
                  ? (setCalMonth(0), setCalYear(calYear + 1))
                  : setCalMonth(calMonth + 1)
              }
              className="p-1.5 -m-1.5"
            >
              <Icon name="chevron" size={16} className="text-sub" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0">
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((d) => (
              <div key={d} className="text-center text-[10px] text-dim py-1">
                {d}
              </div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const ds = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const selected = ds === value;
              return (
                <button
                  key={i}
                  onClick={() => {
                    onChange(ds);
                    setOpen(false);
                  }}
                  className={`h-[32px] text-[13px] rounded-full transition-all ${
                    selected
                      ? "bg-red text-white font-semibold"
                      : "text-text active:bg-card2"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {hasValue && (
            <button
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="w-full text-center text-[13px] text-sub py-2 mt-1"
            >
              Убрать дату
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ═══════════ LABELS (mockup .tags-row / .tag-pill-2) ═══════════

export function LabelsField({
  labels,
  selectedIds,
  onToggle,
  onCreate,
}: {
  labels: ApiLabel[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onCreate: (name: string) => void | Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  // `saving` here is display-only (spinner/disabled styling) — the actual
  // re-entrancy guard against a double tap creating the label twice is
  // useGuardedCallback's synchronous ref below, not this state.
  const [saving, setSaving] = useState(false);

  const submit = useGuardedCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    setSaving(true);
    try {
      await onCreate(trimmed);
      setName("");
      setCreating(false);
    } finally {
      setSaving(false);
    }
  });

  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {labels.map((l) => {
          const active = selectedIds.includes(l.id);
          return (
            <button
              key={l.id}
              onClick={() => onToggle(l.id)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold rounded-[10px] px-3 py-2 transition-colors"
              style={{
                backgroundColor: active
                  ? l.color + "26"
                  : "rgba(255,255,255,.08)",
                color: active ? l.color : "#A6A6A6",
              }}
            >
              {active && <Icon name="check" size={11} />}
              {l.name}
            </button>
          );
        })}
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center text-[12px] font-semibold rounded-[10px] px-3 py-2 text-sub bg-white/[0.08]"
          >
            + новая
          </button>
        )}
      </div>
      {creating && (
        <div className="border-t border-stroke flex items-center gap-2 px-4 py-2.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            placeholder="Название метки"
            className="flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none"
          />
          <button
            onClick={submit}
            disabled={!name.trim() || saving}
            className="p-2 -m-1 shrink-0 disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-red" />
          </button>
          <button
            onClick={() => {
              setCreating(false);
              setName("");
            }}
            className="p-2 -m-1 shrink-0"
          >
            <Icon name="x" size={16} className="text-dim" />
          </button>
        </div>
      )}
      {labels.length === 0 && !creating && (
        <div className="px-4 pb-3 -mt-1 text-[12px] text-dim">
          Меток пока нет
        </div>
      )}
    </div>
  );
}

// ═══════════ SUBTASKS (mockup .card add-row) ═══════════

// Строка подзадачи в форме «Изменить»: переименовать и удалить.
// Отмечать выполненной здесь НЕЛЬЗЯ (решение Максима 15.08.2026) — для
// этого есть лента подзадач в самой карточке; в форме переключатель только
// загромождал строку. Признак готовности остаётся видимым: галочка слева.
export function SubtaskRow({
  title,
  done,
  onRename,
  onDelete,
  dragHandleListeners,
  dragHandleAttributes,
  setDragHandleRef,
  isDragging,
}: {
  title: string;
  done: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  // Перетаскивание — см. SortableSubtaskRow в TaskFormScreen.tsx. Опционально:
  // без dnd-kit-обёртки (create-mode ещё без id, или будущий вызов без
  // переупорядочивания) строка просто не получает ручку и ведёт себя как
  // раньше.
  dragHandleListeners?: DraggableSyntheticListeners;
  dragHandleAttributes?: DraggableAttributes;
  setDragHandleRef?: (el: HTMLElement | null) => void;
  isDragging?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) onRename(trimmed);
    else setValue(title);
  };

  return (
    // Owner 2026-08-13 (седьмой заход): px-4 убран — тот же рассинхрон, что
    // и у AddSubtaskRow ниже (его комментарий разбирает причину подробно):
    // здесь этот отступ был нужен, пока строка стояла внутри Card-рамки
    // (убрана пятым заходом), сейчас это просто лишний сдвиг вправо
    // относительно title/desc textarea и остальных лейблов формы.
    <div
      className={`relative flex items-center gap-3 py-3 ${isDragging ? "opacity-40" : ""}`}
    >
      {dragHandleListeners && (
        // Тот же приём, что у BoardCard на доске (TaskBoard.tsx): ручка —
        // отдельный элемент, перетаскивание стартует только с неё, тап по
        // остальной строке (переименование, `input`) не задет. touch-none —
        // чтобы палец не начинал скролл раньше, чем dnd-kit распознает драг.
        //
        // absolute, НЕ в потоке: строка (её родитель наследует px-4 формы,
        // своего отступа не имеет — см. комментарий выше) не может отдать
        // ручке место в потоке, не сдвинув текст вправо относительно
        // AddSubtaskRow и textarea названия — ровно та рассинхронизация,
        // которую семь заходов правок этого файла как раз убирали. Ручка
        // вместо этого встаёт в сам px-4 gutter слева от строки: left:-16px
        // (=-px-4) до 0 — ровно ширина этого отступа, ни пикселем в текст.
        // Хуже 44×44 канона (TaskFilterButton и т.п.), но шире отступа
        // взять некуда, не сдвинув текст всей формы — цена этого выбора.
        <div
          ref={setDragHandleRef}
          {...dragHandleAttributes}
          {...dragHandleListeners}
          className="absolute left-[-16px] top-0 bottom-0 w-4 flex items-center justify-center touch-none text-dim active:text-sub"
          aria-label="Перетащить подзадачу"
        >
          <Icon name="grip" size={12} />
        </div>
      )}
      {/* Кружка-переключателя здесь нет (решение Максима 15.08.2026): это
          раздел «Изменить», в нём подзадачи правят и удаляют, а отмечают
          выполненными в самой карточке. Лишний элемент только загружал
          строку. Галочка у уже выполненной остаётся — она несёт смысл,
          показывая, что шаг закрыт. */}
      {done && <Icon name="check" size={14} className="text-green shrink-0" />}
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setValue(title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-[16px] text-text outline-none"
        />
      ) : (
        <button
          onClick={() => {
            setValue(title);
            setEditing(true);
          }}
          className="flex-1 min-w-0 text-left"
        >
          <span
            className={`text-[14px] ${done ? "line-through text-sub" : "text-text"}`}
          >
            {title}
          </span>
        </button>
      )}
      <button onClick={onDelete} className="p-2 -m-1 shrink-0">
        <Icon name="x" size={14} className="text-dim" />
      </button>
    </div>
  );
}

// New-subtask input row — mockup's "Добавить подзадачу..." row (48px).
// Owner 2026-08-13 (шестой заход, типографика): decorative gray-bordered
// circle placeholder removed on request — this row is a plain text input,
// not a checkable subtask (those already have their own real circle, see
// SubtaskRow above). Text size dropped 16px to 13px, the "мелкий" (content)
// size the whole form's typography now converges on — see the comment on
// TaskFormScreen's title textarea for the full two-size rationale.
// Седьмой заход: px-4 тоже убран — этот отступ был правильным, пока строка
// стояла ВНУТРИ Card-рамки (bg-card/rounded, убрана пятым заходом): там он
// был внутренним отступом от края плашки. Без рамки он стал просто лишним
// сдвигом вправо относительно title/desc textarea (владелец это и заметил
// — «подзадача начинается в одном месте, описание в другом»). Теперь этот
// ряд наследует общий px-4 родителя формы, как и всё остальное.
//
// value/onChange опциональны и подняты в TaskFormScreen (owner 2026-08-13:
// кнопка диктовки должна писать и сюда, не только в title/desc) — когда
// они переданы, поле становится controlled и родитель может вставлять в
// него надиктованный текст; без них компонент ведёт себя как раньше
// (собственный локальный state), поэтому существующие вызовы не ломаются.
// onFocus/onBlur наружу — тем же способом, каким title/desc уже сообщают
// MicKeyboardBar, в каком поле сейчас курсор.
export function AddSubtaskRow({
  onAdd,
  value: controlledValue,
  onChange: controlledOnChange,
  onFocus,
  onBlur,
}: {
  onAdd: (title: string) => void;
  value?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [localValue, setLocalValue] = useState("");
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : localValue;
  const setValue = isControlled ? controlledOnChange! : setLocalValue;
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue("");
  };
  return (
    // Owner 2026-08-13 (девятый заход, замер, полная переверка по прямому
    // требованию владельца — «всё посчитать»): было minHeight:48 с
    // items-center — тач-таргет 48px, унаследованный от времён, когда
    // строка стояла внутри Card (там центрирование в фикс-высоте было
    // уместно). Три итерации живого замера (getBoundingClientRect) после
    // переезда в общий поток:
    //   1) items-center+minHeight:48 → «Подзадачи»→поле = 22px, не
    //      совпадало с «Заметка»→«Описание» = 12px (эталон был сам неточным,
    //      см. ниже);
    //   2) py-3 (тот же ритм что у SubtaskRow) → 20px, верхний padding
    //      добавлял то, чего нет у textarea (та начинается от верха поля
    //      без своего отступа);
    //   3) pb-3 (только нижний) → 8px сверху (корректно, целиком из mb-2
    //      лейбла) — но 28px СНИЗУ до «Заметка», потому что pb-3 (12px)
    //      складывался с mb-4 родительского wrapper блока подзадач (16px),
    //      двойной источник отступа, тогда как «Название»→mb-4 и
    //      «Описание»→mb-4 дают ровно 16px без дублирования.
    // Итог: mb-4 вместо pb-3 — margin, не padding, тот же приём, что у
    // textarea названия/описания (весь нижний отступ — margin последнего
    // элемента, родительский div больше своего mb не добавляет, см. правку
    // рядом в TaskFormScreen.tsx). Заодно эталон «Заметка»→«Описание» был
    // сам занижен на 4px лишним <span> в разметке лейбла (line-box давал
    // div.bottom ниже текста) — после его удаления оба зазора честно
    // совпадают на 8px.
    <div className="flex items-center gap-3 mb-4">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="Добавить подзадачу..."
        className="flex-1 min-w-0 bg-transparent text-[13px] text-sub placeholder:text-sub outline-none"
      />
      {value.trim() && (
        <button onClick={submit} className="p-2 -m-1 shrink-0">
          <Icon name="check" size={16} className="text-red" />
        </button>
      )}
    </div>
  );
}
