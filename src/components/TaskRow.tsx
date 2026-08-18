// ═══════════ TASK ROW ═══════════
// One list-row rendering of a task (priority dot + title + description +
// labels/due/subtasks/agent-state badges + assignee avatar) — used by the
// list layouts of InboxScreen, ProjectTasksScreen, UpcomingScreen and
// TodayScreen. Built from TodayScreen's former local `TaskRow` (its
// button shape, its priority dot, its title/description stack) and
// extended with the badge types InboxScreen/ProjectTasksScreen/
// UpcomingScreen's near-identical local copies also needed — those three
// screens are gone now, replaced by this one file.
//
// Not a board card: TaskBoard.tsx's BoardCard is a different, denser
// component for the "доска" layout (260px columns) and stays separate —
// this component is only for the "список" layout's full-width rows.
//
// Description now renders as its own line with `line-clamp-2` (CSS
// two-line ellipsis, no manual substring cut) rather than the three
// different treatments the four screens used to have (Today: substring(0,
// 60) + truncate; Upcoming: line-clamp-2, no cut; Inbox/Project: substring
// (0,50) crammed into the badge row) — this is also what mockup-reference/
// index.html's own `.t-title`/`.t-sub`/`.t-meta` split does (title line,
// description line, then a separate badge row), so unifying on it is a
// mockup-fidelity fix, not just deduplication. Press feedback is `tap-row`
// (index.css's own canonical answer for "a row inside a list" — Inbox/
// Project's `active:bg-card/50 transition-colors` was exactly the kind of
// ad-hoc drift that block's own comment calls out) — it lives on the outer
// wrapping <div> now, not a <button>, see the priority-dot comment below
// for why. Label pill always uses the "tag" icon (Upcoming's single label
// pill used "shield" — the odd one out against Inbox/Project/LabelsScreen's
// "tag" convention).
//
// Props below are only for genuine per-screen product differences (what a
// row is allowed to show at all), never for restyling the same badge two
// ways — see each prop's comment for which screen needs it and why.
//
// Priority dot — owner 2026-08-13: it used to be a plain decorative <div>
// inside the row's single <button>, so tapping it just opened the task like
// tapping anywhere else. Split into its OWN <button> (toggles status
// active↔completed, same call TaskDetailScreen's ring already makes) next
// to a second <button> carrying the rest of the row (title/description/
// meta/avatar, still opens the task) — two buttons side by side, not one
// nested in the other, since nested <button>s are invalid HTML and break
// focus/click handling. stopPropagation isn't needed for this: they're
// siblings, not ancestor/descendant, so a dot tap never reaches the row's
// onClick at all. 18px + 12px check icon matches the size TaskDetailScreen
// already uses for its own subtask rows (SubtaskToggleRow in that file,
// TaskFields.tsx's AddSubtaskRow placeholder) — the one size this project's
// checkable circles converge on; TaskDetailScreen's OWN task-status ring
// (22px) and TaskBoard's board-card dot (12px) are unified down/up to this
// same 18px in the same pass, so every priority dot in the app now measures
// the same regardless of which screen it's on.
//
// §2 §5 §8 Apple Design — swipe-left-to-edit (было swipe-to-complete до
// 2026-08-15, чекбоксы и жест убраны в тот же день целиком; жест
// восстановлен 18.08.2026 прямой просьбой — то же ощущение, другое
// действие). Dragging the row left reveals a blue "edit" action behind it.
// setPointerCapture ensures 1:1 tracking even if the pointer leaves the
// element. Direction lock: first pointermove determines if the gesture is
// horizontal (|dx|>|dy|) — if not, scroll is allowed through normally. On
// release: if displacement > SWIPE_THRESHOLD or velocity > SWIPE_VEL,
// navigate straight to the edit form (`/task/:id/edit`) — skipping the
// detail screen and its «Изменить» button entirely, the whole point of the
// gesture. Spring snaps the row back in both cases (with the finger's
// release velocity handed off — §5 velocity handoff). Physics unchanged
// from the original (`response: 0.3, damping: 1`) — already tuned/approved,
// only the released action changed, not the feel.
import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, Avatar, AgentStateTag } from "./UI";
import { getPriorityColor, PRIORITIES } from "../lib/priority";
import {
  formatDueLabel,
  MONTHS_SHORT,
  daysUntil,
  formatDaysLeft,
} from "../lib/date";
import { useSpring } from "../lib/useSpring";
import type { ApiTask } from "../api/types";

// Plain "8 авг" — no relative "Сегодня/Завтра" prefix, no trailing dot.
// Distinct from lib/date.ts's `formatDueLabel` (used just below for the
// overdue-specific red pill, which DOES want that relative prefix) — this
// is the ordinary due-date badge's format, matching what Inbox/Project's
// former local `formatDue` produced. Kept private/unexported: a plain
// function export from a component file trips oxlint's
// react/only-export-components (see lib/priority.ts's own comment on why
// PRIORITY_COLORS/getPriorityColor live outside UI.tsx for the same rule)
function formatDue(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// Swipe-to-edit thresholds — те же числа, что были у swipe-to-complete
// (не подбирались заново, физика уже одобрена).
const SWIPE_THRESHOLD = 72; // px displacement to trigger edit
const SWIPE_VEL = 400; // px/s release velocity to trigger edit

export interface TaskRowProps {
  task: ApiTask;
  onClick: () => void;
  // TodayScreen only: this row is overdue — swaps the ordinary due badge
  // for a red "Просрочено, …" pill (relative label from formatDueLabel).
  overdue?: boolean;
  // Показывать пилюлю статуса агента (AGENT-PROTOCOL.md — "в работе"/"на
  // проверке"/"заблокировано"/"агент пропал"). БЫЛО: только на Today,
  // Inbox/Project/Upcoming намеренно оставляли строку «плоской». СТАЛО
  // (просьба Максима 17.08.2026): статус агента должен быть виден в любом
  // списке, не только на доске и не только на Today — переключился
  // молча на плитке канбана, а в обычном списке пропадал. Default true,
  // а не добавление в каждый экран по одному — чтобы новый список,
  // использующий TaskRow, получал бейдж не по забывчивости, а по умолчанию.
  showAgentState?: boolean;
  // How many label pills to render. Inbox/Project/Today show every label
  // (Infinity, the default); Upcoming only ever showed the first one
  // (pass 1) — Максим 18.08.2026: Today's own metки/счётчик подзадач were
  // OFF (pass 0) same as this file's date badge, on the "keep the row
  // focused" reasoning below — turned out that reasoning only actually
  // held for the date (redundant with "сегодня" itself), not for
  // labels/subtasks, which he wants visible same as everywhere else.
  maxLabels?: number;
  // Ordinary (non-overdue) due-date badge. Default on for Inbox/Project.
  // Off for Upcoming (the date is already that row's group header, a
  // second copy on the row itself would be redundant) and for Today (the
  // one still-valid case of the same reasoning: a task sitting in "Today"
  // is by definition due today, a plain date badge would say nothing a
  // same-day date doesn't already say by being on this screen at all).
  showDueBadge?: boolean;
  // Subtasks-done badge ("2/5"). Default on everywhere, Today included
  // (see maxLabels above — was off, Максим 18.08.2026 wants it back).
  showSubtasksBadge?: boolean;
  // Assignee avatar. Default on everywhere, Today included (was off, same
  // "keep the row focused" reasoning as maxLabels/showSubtasksBadge above
  // — Максим 18.08.2026 wants it back too).
  showAvatar?: boolean;
}

export function TaskRow({
  task,
  onClick,
  overdue = false,
  showAgentState = true,
  maxLabels = Infinity,
  showDueBadge = true,
  showSubtasksBadge = true,
  showAvatar = true,
}: TaskRowProps) {
  const navigate = useNavigate();
  const isDone = task.status === "completed";
  const doneSub = task.subtasks.filter((s) => s.done).length;
  const visibleLabels = maxLabels > 0 ? task.labels.slice(0, maxLabels) : [];

  const hasOverduePill = overdue && !!task.due_date;
  const hasAgentTag = showAgentState && !!task.agent_state;
  const hasDueBadge = showDueBadge && !overdue && !!task.due_date;
  const hasSubtasksBadge = showSubtasksBadge && task.subtasks.length > 0;
  // Флажок только для 1-3: четвёртый — «низкий», значение по умолчанию.
  const hasPriorityFlag = !!task.priority && task.priority <= 3;
  const hasLabels = visibleLabels.length > 0;
  const hasMeta =
    hasPriorityFlag ||
    hasOverduePill ||
    hasAgentTag ||
    hasDueBadge ||
    hasSubtasksBadge ||
    hasLabels;

  // ── Swipe-to-edit (18.08.2026, восстановлено) ──────────────────────────
  // Квадратик-отметка завершения остаётся убранным (Максим 18.08.2026:
  // «не надо мне эти квадратики, они только всё портят») — это только
  // жест, не чекбокс. Сам механизм 1:1 со старым swipe-to-complete
  // (см. историю файла, коммит 8cd89bc~1), только released-действие другое.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLDivElement | null>(null);

  const spring = useSpring(
    (value) => {
      if (rowRef.current)
        rowRef.current.style.transform = `translateX(${value}px)`;
      if (actionRef.current) {
        const frac = Math.min(Math.abs(value) / SWIPE_THRESHOLD, 1);
        actionRef.current.style.opacity = String(frac);
      }
    },
    { response: 0.3, damping: 1 },
  );

  const swipeDrag = useRef({
    active: false,
    locked: false,
    isHorizontal: false,
    startX: 0,
    startY: 0,
    samples: [] as { x: number; t: number }[],
  });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const el = e.currentTarget;

      swipeDrag.current = {
        active: true,
        locked: false,
        isHorizontal: false,
        startX: e.clientX,
        startY: e.clientY,
        samples: [{ x: e.clientX, t: performance.now() }],
      };

      const onMove = (ev: PointerEvent) => {
        const d = swipeDrag.current;
        if (!d.active) return;

        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;

        if (!d.locked && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          d.isHorizontal = Math.abs(dx) > Math.abs(dy);
          d.locked = true;
          if (d.isHorizontal) el.setPointerCapture(ev.pointerId);
        }

        if (!d.locked || !d.isHorizontal) return;

        // Только влево (отрицательный dx → положительный «показ» действия)
        const clampedDx = Math.min(0, dx);
        spring.stop();
        if (rowRef.current)
          rowRef.current.style.transform = `translateX(${clampedDx}px)`;
        if (actionRef.current) {
          const frac = Math.min(Math.abs(clampedDx) / SWIPE_THRESHOLD, 1);
          actionRef.current.style.opacity = String(frac);
        }

        d.samples.push({ x: ev.clientX, t: performance.now() });
        if (d.samples.length > 6) d.samples.shift();
      };

      const onUp = (ev: PointerEvent) => {
        const d = swipeDrag.current;
        d.active = false;
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);

        if (!d.isHorizontal) return;

        const samples = d.samples;
        let vel = 0;
        if (samples.length >= 2) {
          const last = samples[samples.length - 1];
          const prev = samples[samples.length - 2];
          const dt = (last.t - prev.t) / 1000;
          if (dt > 0) vel = (last.x - prev.x) / dt;
        }

        const currentDx = ev.clientX - d.startX;
        const absDx = Math.abs(Math.min(0, currentDx));
        const absVel = Math.abs(Math.min(0, vel));

        const shouldEdit = absDx > SWIPE_THRESHOLD || absVel > SWIPE_VEL;
        if (shouldEdit) navigate(`/task/${task.id}/edit`);

        // Строка всегда едет обратно — уходить со свайпом (как раньше
        // уходила закрытая задача из списка) тут нечему: редактирование
        // не убирает задачу из списка.
        spring.animateTo(0, -vel);
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [navigate, task.id, spring],
  );

  return (
    // -mx-4 full-bleed (найдено 18.08.2026 по скриншоту свайпа: без неё
    // synий action-фон обрывался на границе родительского px-4, до края
    // экрана оставалась голая полоса тёмного фона — тот же класс бага,
    // что чинили на доске, коммит 3e05468 «полоса честно full-bleed»,
    // тот же приём переиспользован). Экран/список даёт px-4 (16px) с
    // каждой стороны (см. InboxScreen.tsx и др.) — растягиваем ровно на
    // него и возвращаем тот же отступ содержимому изнутри (px-4 на
    // button ниже), а не полосе.
    <div style={{ position: "relative", overflow: "hidden" }} className="-mx-4">
      {/* Действие под свайпом — синий «редактировать» (был teal-check у
          завершения; teal и вообще «готово»-семантика тут неуместны, это
          другое действие). */}
      <div
        ref={actionRef}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: "100%",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          paddingRight: "20px",
          backgroundColor: "var(--color-blue)",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        <Icon name="edit" size={22} className="text-white" />
      </div>

      <div
        ref={rowRef}
        onPointerDown={onPointerDown}
        style={{ willChange: "transform" }}
      >
        <button
          onClick={onClick}
          className="tap-row w-full flex items-start gap-3 py-3 px-4 border-b border-stroke/50 bg-bg text-left"
        >
          {/* w-[24px] фиксирована: без неё колонка была бы по ширине Avatar
              (24px) только когда исполнитель есть, иначе не занимала бы места
              вовсе — заголовок задачи гулял бы вправо/влево в зависимости от
              того, назначен ли исполнитель (тот же баг всплыл на доске
              18.08.2026, здесь тот же паттерн: место держится всегда). */}
          <div className="flex flex-col items-center shrink-0 w-[24px]">
            {showAvatar && task.assignee_id && task.assignee_initials && (
              <Avatar
                initials={task.assignee_initials}
                color={task.assignee_color || "#A6A6A6"}
                avatar_url={task.assignee_avatar_url}
                size={24}
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className={`text-[15px] leading-snug truncate ${isDone ? "line-through text-sub" : "text-text"}`}
            >
              {task.title}
            </div>
            {task.description && (
              <div className="text-[13px] text-sub mt-0.5 line-clamp-2">
                {task.description}
              </div>
            )}
            {hasMeta && (
              <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                {/* Приоритет флажком (решение Максима 15.08.2026). Раньше он
                жил цветом обводки отметки — но отметка теперь скрывается,
                пока есть незакрытые подзадачи, и вместе с ней пропадал
                единственный признак срочности. Флажок от отметки не
                зависит и виден всегда. Низкий приоритет не показываем:
                это значение по умолчанию, значок на каждой задаче
                превратился бы в шум. */}
                {hasPriorityFlag && (
                  <Icon
                    name="flag"
                    size={12}
                    style={{ color: getPriorityColor(task.priority) }}
                    aria-label={`Приоритет: ${PRIORITIES.find((p) => p.key === task.priority)?.name ?? ""}`}
                  />
                )}
                {hasOverduePill && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-red/15 text-red">
                    <Icon name="calendarSmall" size={10} /> Просрочено,{" "}
                    {formatDueLabel(task.due_date!)}
                  </span>
                )}
                {visibleLabels.map((l) => (
                  <span
                    key={l.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                    style={{ backgroundColor: l.color + "26", color: l.color }}
                  >
                    <Icon name="tag" size={10} /> {l.name}
                  </span>
                ))}
                {/* Дата + сколько дней осталось (просьба Максима
                15.08.2026): «8 авг · осталось 3 дня». Сама дата отвечает
                на «когда», отсчёт — на «скоро ли», и второе как раз то,
                по чему решают, за что браться. Ближе трёх суток отсчёт
                оранжевый: срок перестал быть абстрактным. */}
                {hasDueBadge && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                    <Icon name="calendarSmall" size={10} />{" "}
                    {formatDue(task.due_date!)}
                    <span
                      className={
                        daysUntil(task.due_date!) <= 3
                          ? "text-orange"
                          : "text-dim"
                      }
                    >
                      · {formatDaysLeft(task.due_date!)}
                    </span>
                  </span>
                )}
                {hasSubtasksBadge && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                    <Icon name="check" size={10} /> {doneSub}/
                    {task.subtasks.length}
                  </span>
                )}
                {/* После счётчика подзадач, не перед ним (просьба Максима
                17.08.2026) — статичные счётчики сначала, живой статус
                агента следом. Тот же порядок в TaskBoard.tsx. */}
                {hasAgentTag && <AgentStateTag task={task} />}
              </div>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}
