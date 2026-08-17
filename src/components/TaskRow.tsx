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
// §2 §5 §8 Apple Design — swipe-left-to-complete (2026-08-15):
// Dragging the row left reveals a teal "complete" action behind it.
// setPointerCapture ensures 1:1 tracking even if the pointer leaves the
// element. Direction lock: first pointermove determines if the gesture is
// horizontal (|dx|>|dy|) — if not, scroll is allowed through normally.
// On release: if displacement > SWIPE_THRESHOLD or velocity > SWIPE_VEL,
// the task is completed. Spring snaps the row back in both cases (with the
// finger's release velocity handed off — §5 velocity handoff).
import { useRef, useCallback } from "react";
import { Icon, Avatar, AgentStateTag } from "./UI";
import { getPriorityColor, PRIORITIES } from "../lib/priority";
import {
  formatDueLabel,
  MONTHS_SHORT,
  daysUntil,
  formatDaysLeft,
} from "../lib/date";
import { useUpdateTask } from "../api/tasks";
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

// Swipe-to-complete thresholds
const SWIPE_THRESHOLD = 72; // px displacement to trigger complete
const SWIPE_VEL = 400; // px/s release velocity to trigger complete

export interface TaskRowProps {
  task: ApiTask;
  onClick: () => void;
  // TodayScreen only: this row is overdue — swaps the ordinary due badge
  // for a red "Просрочено, …" pill (relative label from formatDueLabel).
  overdue?: boolean;
  // TodayScreen only: show the agent-state pill (AGENT-PROTOCOL.md — "в
  // работе"/"на проверке"/"заблокировано"/"агент пропал"). Inbox/Project/
  // Upcoming's plain list rows never showed this.
  showAgentState?: boolean;
  // How many label pills to render. Inbox/Project show every label
  // (Infinity, the default); Upcoming only ever showed the first one
  // (pass 1); Today shows none at all (pass 0) — its row stays a focused
  // "what and why" line without the extra badges the other three carry.
  maxLabels?: number;
  // Ordinary (non-overdue) due-date badge. Default on for Inbox/Project.
  // Off for Upcoming (the date is already that row's group header, a
  // second copy on the row itself would be redundant) and for Today
  // (which only ever shows the overdue-specific red pill, never a plain
  // one for a same-day date).
  showDueBadge?: boolean;
  // Subtasks-done badge ("2/5"). Default on for Inbox/Project/Upcoming,
  // off for Today (same "keep the row focused" reasoning as maxLabels).
  showSubtasksBadge?: boolean;
  // Assignee avatar. Default on for Inbox/Project/Upcoming, off for
  // Today — its row never carried one and nothing in this task asks to
  // add it there.
  showAvatar?: boolean;
}

export function TaskRow({
  task,
  onClick,
  overdue = false,
  showAgentState = false,
  maxLabels = Infinity,
  showDueBadge = true,
  showSubtasksBadge = true,
  showAvatar = true,
}: TaskRowProps) {
  const updateTask = useUpdateTask();
  const isDone = task.status === "completed";
  const doneSub = task.subtasks.filter((s) => s.done).length;
  // Закрыть задачу можно, только когда закрывать нечего: все подзадачи
  // выполнены либо их нет. Уже выполненную всегда можно вернуть в работу —
  // иначе задача с незакрытыми шагами застряла бы в «выполнено» навсегда.
  const canComplete =
    isDone || task.subtasks.length === 0 || doneSub === task.subtasks.length;
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

  // ── Swipe-to-complete ──────────────────────────────────────────────────
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLDivElement | null>(null);

  // Spring snaps the row back after swipe (with velocity handoff)
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
    locked: false, // true once direction determined
    isHorizontal: false,
    startX: 0,
    startY: 0,
    samples: [] as { x: number; t: number }[],
  });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // Don't initiate swipe on the priority dot button area (first 40px)
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

        // Determine direction on first significant movement
        if (!d.locked && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          d.isHorizontal = Math.abs(dx) > Math.abs(dy);
          d.locked = true;

          if (d.isHorizontal) {
            el.setPointerCapture(ev.pointerId);
          }
        }

        if (!d.locked || !d.isHorizontal) return;

        // Only left swipe (negative dx → positive reveal)
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

        // Calculate release velocity
        const samples = d.samples;
        let vel = 0;
        if (samples.length >= 2) {
          const last = samples[samples.length - 1];
          const prev = samples[samples.length - 2];
          const dt = (last.t - prev.t) / 1000;
          if (dt > 0) vel = (last.x - prev.x) / dt; // negative = left swipe
        }

        const currentDx = ev.clientX - d.startX;
        const absDx = Math.abs(Math.min(0, currentDx));
        const absVel = Math.abs(Math.min(0, vel));

        const shouldComplete = absDx > SWIPE_THRESHOLD || absVel > SWIPE_VEL;

        // canComplete — то же правило, что у квадратика ниже: задачу с
        // незакрытыми подзадачами нельзя закрыть случайным тычком. Раньше
        // свайп его не проверял вовсе — можно было обойти запрет жестом,
        // которого квадратик не разрешает (найдено 17.08.2026, Максим:
        // «так оно не должно работать»). Строка просто едет обратно, без
        // действия и без объяснения — так же молча, как сейчас ведёт себя
        // скрытый квадратик у задачи с незакрытыми подзадачами.
        if (shouldComplete && !isDone && canComplete) {
          updateTask.mutate({ id: task.id, status: "completed" });
        }

        // Always snap back to 0 (task disappears from list on complete,
        // or row returns to origin if threshold wasn't met)
        spring.animateTo(0, -vel); // negative vel: spring inherits leftward velocity
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [isDone, canComplete, task.id, updateTask, spring],
  );

  return (
    // Swipe container: overflow hidden clips the action bg
    <div style={{ position: "relative", overflow: "hidden" }}>
      {/* Action revealed on left swipe */}
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
          backgroundColor: "var(--color-teal)",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        <Icon name="check" size={22} className="text-white" />
      </div>

      {/* tap-row sits on this outer div, not on either button — CSS :active
          propagates up to ancestors of whichever element is actually pressed,
          so tapping either the dot or the content button still washes the
          whole row exactly like the old single-<button> row did. */}
      <div
        ref={rowRef}
        className="tap-row w-full flex items-start gap-3 py-3 px-1 border-b border-stroke/50 bg-bg"
        onPointerDown={onPointerDown}
        style={{ willChange: "transform" }}
      >
        {/* Отметка задачи — КВАДРАТ, а не круг (решение Максима 15.08.2026):
            круг остаётся за подзадачами, квадрат за родительской. Форма
            сразу говорит, на каком ты уровне, ещё до чтения текста.

            И появляется она, только когда закрывать действительно можно:
            все подзадачи выполнены либо их нет вовсе. Задача с незакрытыми
            шагами не закрывается случайным тычком — раньше это был один
            промах пальцем. Место при этом сохраняется, иначе строка
            дёргалась бы при закрытии последнего шага. */}
        {canComplete ? (
          <button
            onClick={() =>
              updateTask.mutate({
                id: task.id,
                status: isDone ? "active" : "completed",
              })
            }
            aria-label={isDone ? "Вернуть в работу" : "Отметить выполненной"}
            className="mt-0.5 w-[18px] h-[18px] rounded-md border-2 shrink-0 flex items-center justify-center"
            style={{ borderColor: getPriorityColor(task.priority) }}
          >
            {isDone && <Icon name="check" size={12} className="text-white" />}
          </button>
        ) : (
          /* Отметки нет вовсе, пока есть незакрытые подзадачи — просьба
             Максима 15.08.2026 буквальная: «должны появляться, только когда
             все подзадачи выполнены либо их нет». Пустое место того же
             размера остаётся, чтобы текст не сдвигался при закрытии
             последнего шага; пунктирный контур на этом месте оказался
             отсебятиной и был убран. */
          <div
            className="mt-0.5 w-[18px] h-[18px] shrink-0"
            aria-hidden="true"
          />
        )}
        <button
          onClick={onClick}
          className="flex-1 min-w-0 flex items-start gap-3 text-left"
        >
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
          {showAvatar && task.assignee_id && task.assignee_initials && (
            <Avatar
              initials={task.assignee_initials}
              color={task.assignee_color || "#A6A6A6"}
              size={24}
            />
          )}
        </button>
      </div>
    </div>
  );
}
