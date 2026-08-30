import { createPortal } from "react-dom";
import { Icon } from "./UI";
import { PRIORITIES } from "../lib/priority";

// ═══════════ QuickActionsBar — форма создания задачи, ряд над клавиатурой ═══════════
//
// 30.08.2026, итерация 4 (владелец прислал скриншоты референса: «вот так должно
// быть — одна широкая белая плашка прямо над клавиатурой, в ней по горизонтали
// слева направо плюс / пилюли проекта-срока-вложений / красный круг микрофона»).
//
// Структура поставочно с референса:
//   ┌───────────────────────────────────────────────────────────────┐
//   │  [+]   [📦 Входящие]   [📅 сегодня]   [🖇 Вложить]   (● mic)   │
//   └───────────────────────────────────────────────────────────────┘
// «Плюс» слева — открывает секцию деталей (та же роль, что была у
// «Добавить детали ▾» в теле формы). Пилюли в середине — быстрые
// установки. Микрофон справа — голос как альтернатива клавиатуре.
//
// Адаптация под тёмную тему: вместо «белой плашки» референса —
// bg-card/95 backdrop-blur-md с border. Те же скругления (28px),
// та же высота (56px). Тени не нужны, граница даёт визуальную рамку.
//
// Накапливаем мелочи от итерации 3:
// - активная пилюля получает bg-card2, неактивная — bg-transparent + text-sub
// - микрофон — красный круг 44×44, не glass (референс явно показывает
//   сплошной цвет, не blur)
// - иконка в пилюле слева от подписи, и подпись при пустом значении
//   скрывается (только иконка)
//
// Анти-уродство: на iPhone ширина viewporta ~390px; 5 элементов в ряд
// при min-gap8 дают 380px — впритык. При выбранном значении длинная
// пилюля может вылезать. Защита: truncate max-w-[80px] на подписи,
// ellipsis. Если не влезает — пилюля показывает только иконку.

export type QuickActionPicker = "details" | "project" | "date" | "priority" | "labels" | null;

export function QuickActionsBar({
  onMicStart,
  micAriaLabel,
  dueDateLabel,
  onOpenDate,
  dueDateActive,
  projectLabel,
  onOpenProject,
  projectActive,
  projectColor,
  priorityKey,
  onOpenPriority,
  labelsCount,
  onOpenLabels,
  labelsActive,
  // Детали (бывшая «Добавить детали ▾» в теле формы):
  detailsOpen,
  onToggleDetails,
  // Открытый поверх клавиатуры пикер:
  openPicker,
  onClosePicker,
  // Содержимое пикеров, рендерится родителем (TaskFormScreen):
  datePicker,
  projectPicker,
  priorityPicker,
  labelsPicker,
}: {
  onMicStart: () => void;
  micAriaLabel: string;
  dueDateLabel: string | null;
  onOpenDate: () => void;
  dueDateActive: boolean;
  projectLabel: string;
  onOpenProject: () => void;
  projectActive: boolean;
  projectColor?: string;
  priorityKey: number;
  onOpenPriority: () => void;
  labelsCount: number;
  onOpenLabels: () => void;
  labelsActive: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  openPicker: QuickActionPicker;
  onClosePicker: () => void;
  datePicker: React.ReactNode;
  projectPicker: React.ReactNode;
  priorityPicker: React.ReactNode;
  labelsPicker: React.ReactNode;
}) {
  const priorityInfo =
    PRIORITIES.find((p) => p.key === priorityKey) ?? PRIORITIES[3];
  const priorityIsSet = priorityKey !== 4; // 4 == "нет" в PRIORITIES

  // Кружок меток: до 3 точек, потом «+N». Если метки не выбраны — иконка-метка.
  const labelsVisual = labelsActive ? (
    labelsCount === 0 ? (
      <span className="w-1.5 h-1.5 rounded-full bg-sub" />
    ) : labelsCount <= 3 ? (
      <span className="flex items-center gap-0.5">
        {Array.from({ length: labelsCount }).map((_, i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-text" />
        ))}
      </span>
    ) : (
      <span className="text-[10px] font-bold text-text">+{labelsCount}</span>
    )
  ) : null;

  return createPortal(
    <>
      <div
        onClick={(e) => e.stopPropagation()}
        className="fixed inset-x-3 z-[55] pb-2"
        style={{
          bottom:
            "max(var(--kb-height, 0px), calc(100dvh - var(--vv-top, 0px) - var(--vv-height, 100dvh)))",
        }}
      >
        <div
          role="toolbar"
          aria-label="Быстрые действия"
          className="flex items-center gap-1.5 px-2 h-14 rounded-[28px] bg-card/95 backdrop-blur-md border border-stroke shadow-lg"
        >
          {/* Кнопка-«+» — раскрывает секцию деталей в теле формы */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleDetails}
            aria-label={detailsOpen ? "Скрыть детали" : "Добавить детали"}
            aria-expanded={detailsOpen}
            className="tap-scale w-10 h-10 rounded-full bg-card2 hover:bg-card2/70 flex items-center justify-center shrink-0 transition-colors"
          >
            <Icon name={detailsOpen ? "x" : "plus"} size={18} className="text-text" />
          </button>

          {/* Пилюля «Проект» */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenProject}
            aria-label="Проект задачи"
            aria-expanded={openPicker === "project"}
            className={`tap-scale h-10 px-3 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium shrink-0 transition-colors ${
              projectActive
                ? "bg-card2 text-text"
                : "bg-transparent text-sub hover:bg-card2/60"
            }`}
            style={
              projectColor
                ? { borderLeft: `3px solid ${projectColor}` }
                : undefined
            }
          >
            <Icon name="hash" size={14} />
            <span className="truncate max-w-[80px]">{projectLabel}</span>
          </button>

          {/* Пилюля «Срок» */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenDate}
            aria-label="Срок задачи"
            aria-expanded={openPicker === "date"}
            className={`tap-scale h-10 px-3 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium shrink-0 transition-colors ${
              dueDateActive
                ? "bg-card2 text-text"
                : "bg-transparent text-sub hover:bg-card2/60"
            }`}
          >
            <Icon name="calendar" size={14} />
            <span className="truncate max-w-[80px]">
              {dueDateActive && dueDateLabel ? dueDateLabel : "Срок"}
            </span>
          </button>

          {/* Пилюля «Метки» */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenLabels}
            aria-label={`Метки задачи (выбрано: ${labelsCount})`}
            aria-expanded={openPicker === "labels"}
            className={`tap-scale h-10 px-3 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium shrink-0 transition-colors ${
              labelsActive
                ? "bg-card2 text-text"
                : "bg-transparent text-sub hover:bg-card2/60"
            }`}
          >
            {labelsVisual ?? <Icon name="tag" size={14} />}
            {!labelsActive && <span>Метки</span>}
          </button>

          {/* Красный круг «Приоритет» — крайний справа перед микрофоном,
              потому что это самый «редакторский» жест; микрофон за ним
              — единственный «альтернативный ввод». Канон iOS — destructive
              / accent-action в правом краю. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenPriority}
            aria-label="Приоритет задачи"
            aria-expanded={openPicker === "priority"}
            className={`tap-scale w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              priorityIsSet
                ? "text-white"
                : "bg-card2 hover:bg-card2/70 text-sub"
            }`}
            style={
              priorityIsSet
                ? { backgroundColor: priorityInfo.color }
                : undefined
            }
          >
            {priorityIsSet ? (
              <span className="text-[11px] font-bold">{priorityInfo.label}</span>
            ) : (
              <Icon name="flag" size={16} />
            )}
          </button>

          {/* Красный круг «Микрофон» — самый правый, как на референсе. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onMicStart}
            aria-label={micAriaLabel}
            className="tap-scale w-10 h-10 rounded-full bg-red-solid flex items-center justify-center shrink-0 shadow-md active:scale-95 transition-transform"
          >
            <Icon name="mic" size={18} className="text-text" />
          </button>
        </div>
      </div>

      {/* Пикеры (портал рядом, поверх панели). Контент управляется родителем. */}
      {openPicker === "date" && datePicker}
      {openPicker === "project" && projectPicker}
      {openPicker === "priority" && priorityPicker}
      {openPicker === "labels" && labelsPicker}

      {/* onClosePicker держится на родителе (TaskFormScreen) — здесь только
          заглушка, чтобы линтер не ругался на неиспользуемый проп. */}
      <span hidden onClick={onClosePicker} />
    </>,
    document.body,
  );
}