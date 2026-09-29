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
// element. On release: if displacement > SWIPE_THRESHOLD or velocity >
// SWIPE_VEL, navigate straight to the edit form (`/task/:id/edit`) —
// skipping the detail screen and its «Изменить» button entirely, the whole
// point of the gesture. Spring snaps the row back in both cases (with the
// finger's release velocity handed off — §5 velocity handoff). Release
// physics unchanged from the original (`response: 0.3, damping: 1`,
// SWIPE_THRESHOLD/SWIPE_VEL below) — already tuned/approved, only the
// released action changed, not the feel.
//
// Direction lock (19.08.2026, retuned — владелец: «чуть-чуть хочу вниз-
// вверх, а там залипла и тут же в изменить»). Было: locked at just 6px of
// movement in EITHER axis, direction decided by a bare `|dx| > |dy|` — a
// hand that trembles 1px more sideways than vertically while starting an
// ordinary scroll got permanently classified horizontal, captured the
// pointer, and a fast scroll flick alone could clear SWIPE_VEL from there.
// Two independent fixes, both from this skill's own §10 guidance
// ("hysteresis, ~10px" before committing to a direction) plus the
// asymmetric cost of guessing wrong: misreading a scroll as a swipe throws
// the person into an unrelated screen, misreading a swipe as a scroll just
// means try again — so ties should resolve toward scroll, not swipe.
// DIRECTION_LOCK_PX (constants below, next to SWIPE_THRESHOLD/SWIPE_VEL)
// raises the movement floor before ANY axis decision is made (6 → 10);
// DIRECTION_BIAS then requires dx to clearly dominate dy, not just edge it
// out, before calling the gesture horizontal.
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, Avatar, AgentStateTag, PriorityArrows, ReadyFlag } from "./UI";
import { MarkdownInline } from "./MarkdownInline";
import { hapticCross, hapticDrop } from "../lib/haptics";
import {
  formatDueLabel,
  MONTHS_SHORT,
  daysUntil,
  formatDaysLeft,
} from "../lib/date";
import type { ApiTask } from "../api/types";
import { useDeleteTask } from "../api/tasks";

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
  // Бейдж с названием проекта. Default on (владелец 19.08.2026 попросил
  // его завести — см. hasProjectBadge ниже). Off для Inbox (тот же день,
  // сразу следом): «Входящие» уже группируют задачи заголовками-секциями
  // по проекту, бейдж на каждой строке повторяет то же самое второй раз —
  // ровно та же причина, что у showDueBadge выше (Upcoming/Today — дата
  // уже сказана группировкой экрана).
  showProjectBadge?: boolean;
  // Закрепление внутри проекта (20.08.2026, «закреплять задачи — это
  // внутри уже проекта») — только ProjectTasksScreen передаёт эту пару,
  // остальные экраны не задают её и получают строку 1:1 как раньше.
  // Не ActionsMenu: тут одно действие на строку, портал+anchorRef ради
  // одной иконки на каждой из потенциально многих строк списка — лишнее.
  pinned?: boolean;
  onTogglePin?: () => void;
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
  showProjectBadge = true,
  pinned,
  onTogglePin,
}: TaskRowProps) {
  const navigate = useNavigate();
  const isDone = task.status === "completed";
  // РОДИТЕЛЬ СЧИТАЕТСЯ ПО ДЕТЯМ, А НЕ ПО ШАГАМ (10.09.2026, a195895d).
  //
  // У родительской задачи своей работы нет — её разбиение это и есть
  // дочерние карточки. Пока счётчик смотрел только на subtasks, родитель с
  // пятью детьми и без шагов показывал пустой прогресс, хотя работа шла.
  //
  // Отдельного признака «это родитель» не заводим: есть дети — считаем по
  // ним, нет — по шагам, ровно как раньше.
  // Список получает от сервера два числа (children_total/children_done), а
  // не сами дочерние задачи: полные объекты возит только карточка.
  const kidsTotal = task.children_total ?? task.children?.length ?? 0;
  const countByChildren = kidsTotal > 0;
  const progressTotal = countByChildren ? kidsTotal : task.subtasks.length;
  const doneSub = countByChildren
    ? (task.children_done ??
      (task.children ?? []).filter((c) => c.status === "completed").length)
    : task.subtasks.filter((s) => s.done).length;
  const visibleLabels = maxLabels > 0 ? task.labels.slice(0, maxLabels) : [];

  const hasOverduePill = overdue && !!task.due_date;
  const hasAgentTag = showAgentState && !!task.agent_state;
  const hasDueBadge = showDueBadge && !overdue && !!task.due_date;
  const hasSubtasksBadge = showSubtasksBadge && progressTotal > 0;
  // Флажок теперь про поднятый флаг готовности, а не про приоритет
  // (владелец 11.09.2026). Приоритет уехал вправо шевронами и в ряду
  // бейджей больше не участвует.
  const hasReadyFlag = !!task.ready_for_pickup;
  // «Нужно глубокое исследование» (миграция 052) — бейдж в списке, чтобы
  // владелец видел помеченные карточки, не проваливаясь в каждую.
  const hasResearchFlag = !!task.needs_research;
  const hasLabels = visibleLabels.length > 0;
  // Проект — бейджем с названием, ровно как на доске (владелец
  // 19.08.2026: «нужно бы прописывать, к какому проекту относится
  // задача… ну уж тогда какой-нибудь бейдж сделай»). Оформление один в
  // один с TaskBoard: фон — цвет проекта с прозрачностью, текст — сам
  // цвет. Так один проект выглядит одинаково в списке, на доске и
  // полоской в сетке часов.
  const hasProjectBadge = showProjectBadge && !!task.project_name;
  const hasMeta =
    hasProjectBadge ||
    hasReadyFlag ||
    hasResearchFlag ||
    hasOverduePill ||
    hasDueBadge ||
    hasSubtasksBadge ||
    hasLabels;

  // ── Плавный нативный iOS свайп ────────────────────────────────────────────
  // Влево → синяя «Изменить»; вправо → красная «Удалить».
  // Та же физика, те же пороги, тот же rubber-band.
  const ACTION_W = 84; // ширина каждого действия
  const rowRef = useRef<HTMLDivElement | null>(null);
  const editActionRef = useRef<HTMLButtonElement | null>(null); // правая, синяя
  const deleteActionRef = useRef<HTMLButtonElement | null>(null); // левая, красная
  const currentXRef = useRef(0);
  const [revealed, setRevealed] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTask = useDeleteTask();

  const setRowPosition = (x: number, animated = false) => {
    currentXRef.current = x;
    if (rowRef.current) {
      if (animated) {
        rowRef.current.style.transition =
          "transform 0.28s cubic-bezier(0.2, 0.9, 0.28, 1)";
      } else {
        rowRef.current.style.transition = "none";
      }
      rowRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    // Правая кнопка (Изменить) — появляется при x < 0, ширина растёт вместе со строкой
    if (editActionRef.current) {
      const absX = Math.max(-x, 0);
      const progress = Math.min(absX / ACTION_W, 1.2);
      const btnW = Math.max(absX, ACTION_W); // растягиваем на весь rubber-band
      editActionRef.current.style.pointerEvents =
        absX >= ACTION_W * 0.7 ? "auto" : "none";
      editActionRef.current.style.width = `${btnW}px`;
      if (animated) {
        editActionRef.current.style.transition =
          "opacity 0.28s ease, width 0.28s cubic-bezier(0.2, 0.9, 0.28, 1)";
      } else {
        editActionRef.current.style.transition = "none";
      }
      editActionRef.current.style.opacity = String(Math.min(1, progress * 1.3));
    }
    // Левая кнопка (Удалить) — появляется при x > 0, ширина растёт вместе со строкой
    if (deleteActionRef.current) {
      const absX = Math.max(x, 0);
      const progress = Math.min(absX / ACTION_W, 1.2);
      const btnW = Math.max(absX, ACTION_W); // растягиваем на весь rubber-band
      deleteActionRef.current.style.pointerEvents =
        absX >= ACTION_W * 0.7 ? "auto" : "none";
      deleteActionRef.current.style.width = `${btnW}px`;
      if (animated) {
        deleteActionRef.current.style.transition =
          "opacity 0.28s ease, width 0.28s cubic-bezier(0.2, 0.9, 0.28, 1)";
      } else {
        deleteActionRef.current.style.transition = "none";
      }
      deleteActionRef.current.style.opacity = String(
        Math.min(1, progress * 1.3),
      );
    }
  };

  const swipeDrag = useRef({
    active: false,
    locked: false,
    isHorizontal: false,
    startX: 0,
    startY: 0,
    startOffset: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
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
        startOffset: currentXRef.current,
        lastX: e.clientX,
        lastTime: performance.now(),
        velocity: 0,
      };

      const onMove = (ev: PointerEvent) => {
        const d = swipeDrag.current;
        if (!d.active) return;

        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;

        if (!d.locked && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
          d.isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
          d.locked = true;
          if (d.isHorizontal) {
            el.setPointerCapture(ev.pointerId);
            setIsSwiping(true);
            hapticCross();
          }
        }

        if (!d.locked || !d.isHorizontal) return;

        const now = performance.now();
        const dt = (now - d.lastTime) / 1000;
        if (dt > 0.005) {
          d.velocity = (ev.clientX - d.lastX) / dt;
          d.lastX = ev.clientX;
          d.lastTime = now;
        }

        const raw = d.startOffset + dx;
        let pos = raw;
        if (raw > ACTION_W) {
          // rubber-band вправо за пределами ACTION_W
          const over = raw - ACTION_W;
          pos = ACTION_W + (over * 30) / (30 + over);
        } else if (raw < -ACTION_W) {
          // rubber-band влево за пределами ACTION_W
          const over = -raw - ACTION_W;
          pos = -ACTION_W - (over * 30) / (30 + over);
        }

        setRowPosition(pos, false);
      };

      const onUp = (ev: PointerEvent) => {
        const d = swipeDrag.current;
        d.active = false;
        setIsSwiping(false);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);

        if (!d.isHorizontal) return;

        const dx = ev.clientX - d.startX;
        const currentPos = currentXRef.current;
        const vel = d.velocity;

        if (d.startOffset === 0) {
          if (currentPos < -36 || vel < -280) {
            // Свайп влево → открыть «Изменить»
            setRevealed(true);
            hapticDrop();
            setRowPosition(-ACTION_W, true);
          } else if (currentPos > 36 || vel > 280) {
            // Свайп вправо → открыть «Удалить»
            setRevealed(true);
            hapticDrop();
            setRowPosition(ACTION_W, true);
          } else {
            setRowPosition(0, true);
          }
        } else if (d.startOffset < 0) {
          // Уже открыто «Изменить» (x < 0)
          const shouldKeep = !(dx > 25 || vel > 250);
          setRevealed(shouldKeep);
          setRowPosition(shouldKeep ? -ACTION_W : 0, true);
        } else {
          // Уже открыто «Удалить» (x > 0)
          const shouldKeep = !(dx < -25 || vel < -250);
          setRevealed(shouldKeep);
          setRowPosition(shouldKeep ? ACTION_W : 0, true);
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [navigate, task.id],
  );

  return (
    <>
      <div
        style={{ position: "relative", overflow: "hidden" }}
        className="-mx-4 border-b border-stroke/50"
      >
        {/* Красная кнопка «Удалить» — слева, появляется при свайпе вправо */}
        <button
          ref={deleteActionRef}
          onClick={(e) => {
            e.stopPropagation();
            setRevealed(false);
            setRowPosition(0, true);
            hapticDrop();
            setConfirmDelete(true);
          }}
          aria-label="Удалить задачу"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: ACTION_W,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            paddingLeft: 0,
            background: "#FF3B30",
            pointerEvents: "none",
            opacity: 0,
            border: "none",
            overflow: "hidden",
          }}
        >
          <Icon name="trash" size={28} className="text-white" />
        </button>

        {/* Синяя кнопка «Изменить» — справа, появляется при свайпе влево */}
        <button
          ref={editActionRef}
          onClick={(e) => {
            e.stopPropagation();
            setRevealed(false);
            setRowPosition(0, true);
            navigate(`/task/${task.id}/edit`);
          }}
          aria-label="Изменить задачу"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: ACTION_W,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            paddingRight: 0,
            background: "#007AFF",
            pointerEvents: "none",
            opacity: 0,
            border: "none",
            overflow: "hidden",
          }}
        >
          <Icon name="edit" size={28} className="text-white" />
        </button>

        <div
          ref={rowRef}
          // Свайп строки (влево — изменить, вправо — удалить) конфликтует со
          // свайпом «назад», который с 26.08.2026 ловится по всему экрану.
          // Атрибут исключает строку из его зоны (useSwipeBack).
          data-hswipe
          onPointerDown={onPointerDown}
          className="bg-bg"
          style={{
            willChange: "transform",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <button
            onClick={() => {
              // Строка приоткрыта — первый тап её закрывает, а не открывает
              // задачу: иначе промахнуться мимо кнопки значило бы всё равно
              // куда-то провалиться.
              if (revealed) {
                setRevealed(false);
                setRowPosition(0, true);
                return;
              }
              onClick();
            }}
            // pt меньше pb — та же правка, что на карточках доски
            // (владелец 19.08.2026: «это и списков касается»). Симметричные
            // py-3 давали НЕсимметричный воздух: замер по чернильным
            // пикселям — сверху 15.3–17.7pt против 13–14pt снизу, потому что
            // сверху добавляются поле внутри PNG аватарки и полулидинг
            // первой строки, а нижние пилюли прижаты к своей кромке.
            // Выравнивание по нижней части, как он и просил.
            className={`w-full flex items-start justify-between gap-2 pt-[9px] pb-3 px-4 bg-bg text-left${isSwiping ? "" : " tap-row"}`}
          >
            <div className="flex-1 min-w-0 flex flex-col items-start">
              {/* Проект — САМОЙ ВЕРХНЕЙ строкой, над названием задачи */}
              {hasProjectBadge && (
                <div
                  className="mb-1 inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] font-medium"
                  style={{ color: task.project_color || "#A6A6A6" }}
                >
                  <Icon name="hash" size={10} className="shrink-0" />
                  <span className="truncate">{task.project_name}</span>
                </div>
              )}

              {/* Строка названия с аватаркой исполнителя (если назначен) */}
              <div className="w-full flex items-center gap-2 min-w-0">
                {showAvatar && task.assignee_id && task.assignee_initials && (
                  <Avatar
                    initials={task.assignee_initials}
                    color={task.assignee_color || "#A6A6A6"}
                    avatar_url={task.assignee_avatar_url}
                    size={20}
                  />
                )}
                <div
                  className={`text-[15px] leading-snug truncate flex-1 min-w-0 ${isDone ? "line-through text-sub" : "text-text"}`}
                >
                  <MarkdownInline source={task.title} />
                </div>
              </div>

              {/* Описание — на всю ширину карточки */}
              {task.description && (
                <div className="w-full text-[13px] text-sub mt-1 line-clamp-2">
                  <MarkdownInline source={task.description} />
                </div>
              )}

              {/* Статус агента — сразу после заметки (описания), своей
              строкой, просто цветное слово без плашки-фона (Максим
              26.08.2026). Из ряда бейджей ниже убран. */}
              {hasAgentTag && (
                <div className="w-full mt-1">
                  <AgentStateTag task={task} plain />
                </div>
              )}
              {hasMeta && (
                <div className="w-full flex items-center gap-1.5 flex-wrap mt-1.5 justify-start text-left">
                  {/* 1. Бейдж подзадач (всегда первый) */}
                  {hasSubtasksBadge && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-card text-sub font-medium">
                      {doneSub}/{progressTotal}
                    </span>
                  )}

                  {/* 2. Поднятый флаг готовности — освободившийся флажок.
                      Приоритет с 11.09.2026 рисуется шевронами справа. */}
                  {task.ready_for_pickup ? <ReadyFlag /> : null}

                  {/* 2.1. Помечена как глубокое исследование (миграция 052) */}
                  {task.needs_research ? (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-card text-sub font-medium"
                      title="Нужно глубокое исследование"
                    >
                      <Icon name="search" size={10} /> Исследование
                    </span>
                  ) : null}

                  {/* 3. Просрочено */}
                  {hasOverduePill && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-red/15 text-red font-medium">
                      <Icon name="calendarSmall" size={10} /> Просрочено,{" "}
                      {formatDueLabel(task.due_date!)}
                    </span>
                  )}

                  {/* 4. Дата + сколько дней осталось */}
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

                  {/* 5. Метки */}
                  {visibleLabels.map((l) => (
                    <span
                      key={l.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                      style={{
                        backgroundColor: l.color + "26",
                        color: l.color,
                      }}
                    >
                      <Icon name="tag" size={10} /> {l.name}
                    </span>
                  ))}

                  {/* 6. Статус агента переехал под заметку отдельной
                    строкой (Максим 26.08.2026) — см. выше. */}
                </div>
              )}
            </div>
            {/* Закрепление (ProjectTasksScreen only) — третий flex-child
              рядом с content column, тот же приём, что дальше в этом файле
              не используется, но 1:1 со вторым интерактивным элементом
              внутри чужой полноширинной кнопки — BoardCard в TaskBoard.tsx
              (drag-хэндл там же: div со своими onClick/stopPropagation
              внутри кнопки-карточки, не вложенный <button>). content
              column выше — flex-1 min-w-0, поэтому уступает место сама,
              никакого abs-position и риска наехать на truncate-текст. */}
            {/* Приоритет — стопкой шевронов у правого края (владелец
                11.09.2026: «раз он высокий, чтобы всё вылазило»). В ряд по
                горизонтали четыре стрелки слипались в зигзаг. Рисуются все
                четыре уровня, включая низкий. */}
            <div className="shrink-0 flex items-start pt-[3px]">
              <PriorityArrows priority={task.priority} />
            </div>
            {onTogglePin && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 w-[28px] -mr-1 flex items-start justify-center pt-[2px] text-dim active:text-sub"
                aria-label={pinned ? "Открепить" : "Закрепить"}
              >
                <Icon
                  name="pin"
                  size={16}
                  className={pinned ? "text-orange" : ""}
                />
              </div>
            )}
          </button>
        </div>
      </div>

      {/* Подтверждение удаления — iOS action sheet стиль */}
      {confirmDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
          onClick={() => setConfirmDelete(false)}
        >
          <div
            style={{
              margin: "0 12px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Карточка с текстом и кнопкой «Удалить» */}
            <div
              style={{
                background: "rgba(30,30,32,0.97)",
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "16px 16px 12px",
                  textAlign: "center",
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "rgba(255,255,255,0.95)",
                    marginBottom: 4,
                  }}
                >
                  Удалить задачу?
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(255,255,255,0.5)",
                    lineHeight: 1.4,
                  }}
                >
                  «{task.title}» будет удалена безвозвратно
                </div>
              </div>
              <button
                style={{
                  width: "100%",
                  padding: "15px 16px",
                  fontSize: 17,
                  fontWeight: 600,
                  color: "#FF3B30",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setConfirmDelete(false);
                  hapticDrop();
                  deleteTask.mutate(task.id);
                }}
              >
                Удалить
              </button>
            </div>

            {/* Кнопка «Отмена» — отдельная карточка */}
            <button
              style={{
                width: "100%",
                padding: "16px",
                fontSize: 17,
                fontWeight: 600,
                color: "rgba(255,255,255,0.95)",
                background: "rgba(30,30,32,0.97)",
                border: "none",
                borderRadius: 16,
                cursor: "pointer",
                marginBottom: "env(safe-area-inset-bottom, 0px)",
              }}
              onClick={() => setConfirmDelete(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </>
  );
}
