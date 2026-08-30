// ═══════════ TASK FILTER SHEET (Inbox / Today / Upcoming) ═══════════
// Same bottom-sheet chrome as ActivityScreen.tsx's own filter sheet (scrim
// + bg-card rounded-sheet-top panel, Card/FieldRow facets that expand in
// place) — taken as the style reference per direct instruction. Trimmed
// down from it, though: no "Период" facet (these screens have their own
// date dimension already — Today's overdue/today split, Upcoming's
// calendar — a rolling-window period would only fight with that), so this
// sheet is just Проект/Метка/Исполнитель, three facets instead of four.
//
// Shared by all three screens rather than copy-pasted three times: the
// sheet's own markup doesn't vary between them at all, only the task list
// each screen feeds it does.
import { useEffect, useState } from "react";
import { Icon, Avatar, SheetHandle } from "./UI";
import { Card, FieldRow } from "./TaskFields";
import { useBottomSheet } from "../lib/useBottomSheet";
import {
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
  type TaskFilterOption,
  type TaskAssigneeOptions,
} from "../lib/taskFilters";
import type { ApiProject } from "../api/types";

// ═══════════ FILTER BUTTON (header trigger) ═══════════
// Icon-only, 44×44 — единый вид кнопки фильтра во ВСЁМ приложении
// (26.08.2026: ActivityScreen была единственным исключением — текстовая
// пилюля «Фильтры», приведена к этому же виду).
//
// Красной точки-индикатора «что-то выбрано» НЕТ — убрана по прямой
// просьбе Максима 26.08.2026 («не надо подсвечивать, что что-то там
// выбрано, мне надо — я зайду посмотрю»). Проп `active` больше не
// принимается: экраны не должны считать счётчики ради несуществующего
// индикатора.
export function TaskFilterButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Фильтры"
      className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
    >
      <Icon name="filter" size={18} className="text-text" />
    </button>
  );
}

// ═══════════ ONE FACET (Проект / Метка) ═══════════
function FilterPicker({
  sectionKey,
  openSection,
  setOpenSection,
  fieldIcon,
  fieldLabel,
  allLabel,
  currentLabel,
  optionIcon,
  options,
  selectedId,
  onSelect,
  emptyText,
}: {
  sectionKey: string;
  openSection: string | null;
  setOpenSection: (k: string | null) => void;
  fieldIcon: string;
  fieldLabel: string;
  allLabel: string;
  currentLabel: string;
  optionIcon: string;
  options: TaskFilterOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  emptyText: string;
}) {
  const isOpen = openSection === sectionKey;
  return (
    <Card>
      <FieldRow
        icon={fieldIcon}
        label={fieldLabel}
        value={currentLabel}
        chevronOpen={isOpen}
        onClick={() => setOpenSection(isOpen ? null : sectionKey)}
      />
      {isOpen && (
        <div className="border-t border-stroke">
          <button
            onClick={() => onSelect(null)}
            className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
          >
            <span className="text-[14px] text-text flex-1">{allLabel}</span>
            {selectedId === null && (
              <Icon name="check" size={16} className="text-red" />
            )}
          </button>
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onSelect(opt.id)}
              className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
            >
              <Icon name={optionIcon} size={16} style={{ color: opt.color }} />
              <span className="text-[14px] text-text flex-1 truncate">
                {opt.label}
              </span>
              {selectedId === opt.id && (
                <Icon name="check" size={16} className="text-red" />
              )}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-dim">{emptyText}</div>
          )}
        </div>
      )}
    </Card>
  );
}

// ═══════════ SHEET ═══════════
export function TaskFilterSheet({
  open,
  onClose,
  filters,
  setFilters,
  projectOptions,
  labelOptions,
  assigneeOptions,
  plannerProjects,
}: {
  open: boolean;
  onClose: () => void;
  filters: TaskFilters;
  setFilters: (f: TaskFilters) => void;
  projectOptions: TaskFilterOption[];
  labelOptions: TaskFilterOption[];
  assigneeOptions: TaskAssigneeOptions;
  /** Постоянный набор проектов экрана («Показывать в разделе») — только
   *  «Сегодня» его передаёт. Максим 26.08.2026: отдельная кнопка-папка в
   *  шапке дублировала фильтр по виду и путала — переехала СЮДА, отдельной
   *  секцией; её место в шапке занял Дневник. Отличие от «Проект» выше
   *  осталось прежним: там разовый выбор ОДНОГО проекта, здесь постоянный
   *  список тех, что вообще показывать.
   *
   *  Шаг 2 (feature/projects-decouple-planner-merge): заменили
   *  `hiddenProjectIds` на `visibleProjectIds` (Record<string, true>) —
   *  семантика противоположная, новое поле в сторе
   *  plannerVisibleProjects. Старый hidden-словарь остался в сторе как
   *  legacy, но в формулах больше не используется. `disabled` оставлено
   *  как deprecated на случай Шага 3. */
  plannerProjects?: {
    projects: ApiProject[];
    visibleProjectIds: Record<string, true>;
    onToggle: (projectId: string) => void;
    /** Если передано, при монтировании шторки эта секция сразу
     *  раскрыта. Используется экраном для тапа по [+] в PlannerProjectChips
     *  — пользователь сразу видит picker, без второго клика. При
     *  повторном открытии шторки (useEffect ниже) — сбрасывается. */
    defaultOpenSection?: "planner";
    /** Deprecated: заморозка UI Шага 1. В Шаге 2 не передаётся. */
    disabled?: boolean;
  };
}) {
  const [openSection, setOpenSection] = useState<string | null>(null);

  // Синхронизируем openSection с prop'ом open и plannerProjects.defaultOpenSection.
  // До Шага 2 тут был простой if (open) setOpenSection(null) — работал, потому
  // что openSection инициализировался дефолтом шторки (никаких preferred-секций).
  // Шаг 2 ввёл defaultOpenSection: "planner" — экран хочет, чтобы при тапе по
  // [+] в PlannerProjectChips picker сразу был раскрыт. Прошлый useEffect
  // срабатывал на первом монтировании с open=true и затирал useState-init
  // до null, поэтому фикс проваливался. Теперь: при открытии шторки ставим
  // defaultOpenSection (если экран её просил), при закрытии — null.
  // Повторное открытие с тем же defaultOpenSection снова раскрывает нужную
  // секцию, потому что зависимость [open, defaultOpenSection] валидна на
  // каждом переходе open.
  useEffect(() => {
    if (open) {
      setOpenSection(plannerProjects?.defaultOpenSection ?? null);
    } else {
      setOpenSection(null);
    }
  }, [open, plannerProjects?.defaultOpenSection]);

  // §3 Interruptibility, §5 Velocity handoff, §7 Spatial consistency
  const sheet = useBottomSheet({ open, onClose });

  if (!sheet.mounted) return null;

  const hasActive =
    !!filters.projectId ||
    !!filters.labelId ||
    !!filters.assigneeKey ||
    filters.showCompleted;

  // Шаг 2: visible-семантика — счётчик «сколько проектов добавлено
  // пользователем в ежедневник». Раньше здесь был plannerHiddenCount
  // (сколько спрятано), но Шаг 1 фикс уже сделал hidden-словарь
  // legacy; теперь UI водим только по visible-словарю.
  const plannerVisibleCount = plannerProjects
    ? plannerProjects.projects.filter(
        (p) => plannerProjects.visibleProjectIds[p.id],
      ).length
    : 0;

  const projectLabel =
    (filters.projectId &&
      projectOptions.find((p) => p.id === filters.projectId)?.label) ||
    "Все проекты";
  const labelLabel =
    (filters.labelId &&
      labelOptions.find((l) => l.id === filters.labelId)?.label) ||
    "Все метки";
  const assigneeLabel =
    filters.assigneeKey === "__none"
      ? "Без исполнителя"
      : (filters.assigneeKey &&
          assigneeOptions.list.find((a) => a.id === filters.assigneeKey)
            ?.name) ||
        "Все исполнители";

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* Scrim: opacity animated by useBottomSheet spring */}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle: drag target for dismiss gesture */}
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          {/* Заголовок шторки — 17px, как заголовок вторичного экрана
              (ScreenHeader variant="compact"): шторка это тот же уровень
              навигации. 16px здесь был сиротой вне шкалы — в проекте 16px
              значит «поле ввода, защита от автозума iOS», см. index.css. */}
          <h3 className="text-[17px] font-semibold text-text">Фильтры</h3>
          <button
            onClick={() => setFilters(DEFAULT_TASK_FILTERS)}
            disabled={!hasActive}
            className="text-[13px] text-sub disabled:opacity-40 -mr-1 px-2 h-11"
          >
            Сбросить
          </button>
        </div>

        <div className="flex flex-col gap-3 pb-3">
          <FilterPicker
            sectionKey="project"
            openSection={openSection}
            setOpenSection={setOpenSection}
            fieldIcon="hash"
            fieldLabel="Проект"
            allLabel="Все проекты"
            currentLabel={projectLabel}
            optionIcon="hash"
            options={projectOptions}
            selectedId={filters.projectId}
            onSelect={(id) => {
              setFilters({ ...filters, projectId: id });
              setOpenSection(null);
            }}
            emptyText="Нет задач с проектом"
          />

          <FilterPicker
            sectionKey="label"
            openSection={openSection}
            setOpenSection={setOpenSection}
            fieldIcon="tag"
            fieldLabel="Метка"
            allLabel="Все метки"
            currentLabel={labelLabel}
            optionIcon="tag"
            options={labelOptions}
            selectedId={filters.labelId}
            onSelect={(id) => {
              setFilters({ ...filters, labelId: id });
              setOpenSection(null);
            }}
            emptyText="Нет задач с метками"
          />

          <Card>
            <FieldRow
              icon="person"
              label="Исполнитель"
              value={assigneeLabel}
              chevronOpen={openSection === "assignee"}
              onClick={() =>
                setOpenSection(openSection === "assignee" ? null : "assignee")
              }
            />
            {openSection === "assignee" && (
              <div className="border-t border-stroke">
                <button
                  onClick={() => {
                    setFilters({ ...filters, assigneeKey: null });
                    setOpenSection(null);
                  }}
                  className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
                >
                  <span className="text-[14px] text-text flex-1">
                    Все исполнители
                  </span>
                  {filters.assigneeKey === null && (
                    <Icon name="check" size={16} className="text-red" />
                  )}
                </button>
                {assigneeOptions.list.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setFilters({ ...filters, assigneeKey: a.id });
                      setOpenSection(null);
                    }}
                    className="tap-row w-full flex items-center gap-3 py-2.5 px-4 text-left"
                  >
                    <Avatar
                      initials={a.initials}
                      color={a.color}
                      avatar_url={a.avatar_url}
                      size={24}
                    />
                    <span className="text-[14px] text-text flex-1 truncate">
                      {a.name}
                    </span>
                    {filters.assigneeKey === a.id && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                ))}
                {assigneeOptions.hasUnassigned && (
                  <button
                    onClick={() => {
                      setFilters({ ...filters, assigneeKey: "__none" });
                      setOpenSection(null);
                    }}
                    className="tap-row w-full flex items-center gap-3 py-2.5 px-4 text-left"
                  >
                    <div className="w-[24px] h-[24px] rounded-full bg-card2 flex items-center justify-center shrink-0">
                      <Icon name="person" size={12} className="text-dim" />
                    </div>
                    <span className="text-[14px] text-text flex-1">
                      Без исполнителя
                    </span>
                    {filters.assigneeKey === "__none" && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                )}
                {assigneeOptions.list.length === 0 &&
                  !assigneeOptions.hasUnassigned && (
                    <div className="px-4 py-3 text-[13px] text-dim">
                      Нет данных об исполнителях
                    </div>
                  )}
              </div>
            )}
          </Card>

          {/* Выполненные (просьба Максима 15.08.2026). Отдельной карточкой,
              а не пунктом в списке полей: это не «чем сузить выборку», а
              «что вообще показывать» — другой по смыслу переключатель.
              По умолчанию выключен: список задач отвечает на вопрос «что
              делать», а не «что сделано». */}
          <Card>
            <button
              onClick={() =>
                setFilters({
                  ...filters,
                  showCompleted: !filters.showCompleted,
                })
              }
              role="switch"
              aria-checked={filters.showCompleted}
              className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
            >
              <Icon name="check" size={18} className="text-sub shrink-0" />
              <span className="text-[14px] text-text flex-1">
                Показывать выполненные
              </span>
              {/* Тот же переключатель, что в настройках: 43×25 с белым
                  кружком — свой второй вид тут заводить незачем. */}
              <span
                className={`relative w-[43px] h-[25px] rounded-full shrink-0 transition-colors ${
                  filters.showCompleted
                    ? "bg-red"
                    : "bg-card2 border border-stroke"
                }`}
              >
                <span
                  className="absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-toggle transition-[right] duration-150"
                  style={{ right: filters.showCompleted ? "2.5px" : "20.5px" }}
                />
              </span>
            </button>
          </Card>

          {/* ═══ Показывать в разделе ═══
              Постоянный набор проектов экрана (бывшая кнопка-папка в шапке).
              Не «чем сузить прямо сейчас» (это всё выше и сбрасывается
              «Сбросить»), а «что этот раздел показывает вообще» — поэтому
              своей карточкой внизу, с раскрытием, и НЕ трогается кнопкой
              «Сбросить».

              Шаг 2 (feature/projects-decouple-planner-merge): перевернули
              семантику с «скрыть проект» на «включить проект в раздел».
              Раньше здесь был свитчер с логикой «выключено = задачи
              проекта не попадают в ежедневник». Теперь «включено = задачи
              попадают», а дефолт (visible пустой) = ежедневник показывает
              только входящие. Шапка чипов PlannerProjectChips — парный
              UI: видно что выбрано, добавить — через эту секцию. */}
          {plannerProjects && plannerProjects.projects.length > 0 && (
            <Card>
              <FieldRow
                icon="folder"
                label="Показывать в разделе"
                value={
                  plannerVisibleCount === 0
                    ? "Проекты не выбраны"
                    : `Проектов: ${plannerVisibleCount}`
                }
                chevronOpen={openSection === "planner"}
                onClick={() =>
                  setOpenSection(openSection === "planner" ? null : "planner")
                }
              />
              {openSection === "planner" && (
                <div className="border-t border-stroke">
                  <div className="px-4 pt-2.5 pb-1 text-[12px] text-dim">
                    {plannerProjects.disabled
                      ? "В этот раздел попадают только задачи без проекта. Чтобы добавить проект — открой настройки раздела."
                      : "Выбери проекты, задачи которых показывать в этом разделе. По умолчанию раздел показывает только задачи без проекта."}
                  </div>
                  {(() => {
                    if (plannerProjects.projects.length === 0) {
                      return (
                        <div className="px-4 py-3 text-[13px] text-dim">
                          Нет проектов для добавления
                        </div>
                      );
                    }
                    const allAdded = plannerProjects.projects.every(
                      (p) => plannerProjects.visibleProjectIds[p.id],
                    );
                    if (allAdded) {
                      return (
                        <div className="px-4 py-3 text-[13px] text-dim">
                          Все проекты уже в разделе
                        </div>
                      );
                    }
                    // Та же multi-select UX, что и в Шаге 1, только
                    // семантика инвертирована: «включено = проект в
                    // ежедневнике», а не «выключено = спрятан».
                    // Удаление через picker — тап по уже включённому
                    // (Максим: «свайп по чипу — слишком мелкая цель,
                    // лучше явная кнопка»).
                    return plannerProjects.projects.map((p) => {
                      const isIn = !!plannerProjects.visibleProjectIds[p.id];
                      const isDisabled = !!plannerProjects.disabled;
                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            if (isDisabled) return;
                            plannerProjects.onToggle(p.id);
                          }}
                          role="switch"
                          aria-checked={isIn}
                          disabled={isDisabled}
                          aria-disabled={isDisabled}
                          className={
                            "tap-row w-full flex items-center gap-3 py-2.5 px-4 text-left" +
                            (isDisabled ? " opacity-40 cursor-not-allowed" : "")
                          }
                        >
                          <Icon
                            name="hash"
                            size={16}
                            style={{ color: p.color }}
                          />
                          <span
                            className={
                              "text-[14px] flex-1 truncate " +
                              (isDisabled ? "text-sub" : "text-text")
                            }
                          >
                            {p.name}
                          </span>
                          <span
                            className={`relative w-[43px] h-[25px] rounded-full shrink-0 transition-colors ${
                              isIn
                                ? "bg-red"
                                : "bg-card2 border border-stroke"
                            }`}
                          >
                            <span
                              className="absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-toggle transition-[right] duration-150"
                              style={{ right: isIn ? "2.5px" : "20.5px" }}
                            />
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
