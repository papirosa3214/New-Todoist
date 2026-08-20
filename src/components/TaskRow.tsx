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
import { Icon, Avatar, AgentStateTag } from "./UI";
import { getPriorityColor, PRIORITIES } from "../lib/priority";
import { hapticCross, hapticDrop } from "../lib/haptics";
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
// Velocity сама по себе — мгновенная скорость по ПОСЛЕДНИМ ДВУМ сэмплам
// (см. onUp), не средняя за весь жест. Короткое резкое касание в
// несколько px за пару миллисекунд легко даёт >400px/s при почти нулевом
// реальном смещении — «buквально миллиметрик — и сразу в изменении»,
// живая жалоба владельца 19.08.2026 ПОСЛЕ первого захода тюнинга
// (direction-lock ниже), то есть это отдельная, вторая дыра: velocity-
// путь не требовал вообще никакого минимального смещения. Теперь требует
// — половина SWIPE_THRESHOLD: скорость решает, дошёл ли до готового
// действия РЕЗКИЙ свайп, а не заменяет собой факт движения.
const SWIPE_VEL_MIN_DX = SWIPE_THRESHOLD / 2; // px — ниже этого velocity не считается
// Direction-lock tuning — see the comment block above for why. Не путать
// с SWIPE_THRESHOLD/SWIPE_VEL: те решают «отпустили — открывать
// редактирование или нет», а эти два — «это вообще горизонтальный жест
// или человек просто скроллит».
// На сколько строка приоткрывается и остаётся стоять — ровно под кнопку с
// карандашом: 72px под палец плюс её правый отступ 20px.
const ACTION_W = 92;
const DIRECTION_LOCK_PX = 10; // px до первого решения об оси (было 6)
const DIRECTION_BIAS = 1.4; // dx должен явно преобладать над dy, не только edge out

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
  // Проект — бейджем с названием, ровно как на доске (владелец
  // 19.08.2026: «нужно бы прописывать, к какому проекту относится
  // задача… ну уж тогда какой-нибудь бейдж сделай»). Оформление один в
  // один с TaskBoard: фон — цвет проекта с прозрачностью, текст — сам
  // цвет. Так один проект выглядит одинаково в списке, на доске и
  // полоской в сетке часов.
  const hasProjectBadge = showProjectBadge && !!task.project_name;
  const hasMeta =
    hasProjectBadge ||
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
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // Строка приоткрыта и держит кнопку — тап по самой строке в этом
  // состоянии закрывает её, а не открывает задачу.
  const [revealed, setRevealed] = useState(false);

  const spring = useSpring(
    (value) => {
      if (rowRef.current)
        rowRef.current.style.transform = `translateX(${value}px)`;
      if (actionRef.current) {
        // Прозрачностью больше не играем: кнопка просто лежит под строкой
        // и открывается по мере её сдвига — «как ящичек». Раньше слой
        // проявлялся во всю ширину, и полотно синело целиком.
        const frac = Math.min(Math.abs(value) / ACTION_W, 1);
        actionRef.current.style.pointerEvents = frac > 0.9 ? "auto" : "none";
      }
    },
    { response: 0.3, damping: 1 },
  );

  const swipeDrag = useRef({
    active: false,
    locked: false,
    isHorizontal: false,
    // Прошли ли уже ширину кнопки — см. onMove, отклик на пересечении.
    pastAction: false,
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
        pastAction: false,
        startX: e.clientX,
        startY: e.clientY,
        samples: [{ x: e.clientX, t: performance.now() }],
      };

      const onMove = (ev: PointerEvent) => {
        const d = swipeDrag.current;
        if (!d.active) return;

        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;

        if (
          !d.locked &&
          (Math.abs(dx) > DIRECTION_LOCK_PX || Math.abs(dy) > DIRECTION_LOCK_PX)
        ) {
          d.isHorizontal = Math.abs(dx) > Math.abs(dy) * DIRECTION_BIAS;
          d.locked = true;
          if (d.isHorizontal) {
            el.setPointerCapture(ev.pointerId);
            // Строка «взялась» за палец. Отклик именно здесь, на решении об
            // оси, а не на pointerdown: до этого места ещё не известно,
            // свайп это или прокрутка списка, и щёлкать на каждом касании
            // экрана значило бы щёлкать на прокрутке.
            hapticCross();
          }
        }

        if (!d.locked || !d.isHorizontal) return;

        // Только влево. За пределом открытой позиции — РЕЗИНКА, а не жёсткий
        // упор (Apple Design §9: у границы сопротивление нарастает, «стоп»
        // читается как зависание). Формула оттуда же.
        const raw = Math.min(0, dx);
        const over = Math.max(0, -raw - ACTION_W);
        const eased =
          over > 0
            ? -(ACTION_W + (over * ACTION_W * 0.55) / (ACTION_W + 0.55 * over))
            : raw;
        spring.stop();
        if (rowRef.current)
          rowRef.current.style.transform = `translateX(${eased}px)`;
        // Прозрачность кнопки не трогаем: она открывается сдвигом строки.

        // Кнопка вышла из-под строки целиком — с этого места отпускание
        // оставит строку открытой. Порог перешли — щёлкнули, ровно один
        // раз на пересечение (в обе стороны).
        const past = -eased >= ACTION_W;
        if (past !== d.pastAction) {
          d.pastAction = past;
          hapticCross();
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

        // Свайп больше НЕ выполняет действие сам — он только приоткрывает
        // строку и показывает кнопку с карандашом (владелец 19.08.2026:
        // «чувствительность безумная, это меня уже раздражает; должно не
        // сразу измениться, а просто чуть-чуть карточка сдвигается и
        // появляется кнопка с карандашом, на которую я потом нажимаю»).
        // Отсюда и снятая острота порогов: ошибиться теперь не страшно —
        // цена промаха не «улетел в чужой экран», а «строка приоткрылась».
        // Куда жест ЛЕТИТ, а не где отпустили: проекция точки остановки по
        // затуханию инерции (Apple Design §6, их же формула с
        // decelerationRate 0.998), и уже к ней подбирается ближайшая точка
        // привязки — закрыто или открыто. Порог по расстоянию остаётся
        // страховкой для медленного перетаскивания без скорости.
        const projected =
          -absDx + (Math.min(0, vel) / 1000) * (0.998 / (1 - 0.998));
        // Проекция считается только после ощутимого хода: без этого порога
        // короткий резкий рывок на 20px «долетал» до открытой позиции и
        // открывал строку — ровно то «в пол пинка», от которого владелец и
        // просил уйти (поймано своим же тестом 19.08.2026).
        const projectionCounts = absDx > SWIPE_VEL_MIN_DX;
        const shouldReveal =
          (projectionCounts &&
            Math.abs(projected - -ACTION_W) < Math.abs(projected - 0)) ||
          absDx > SWIPE_THRESHOLD;
        setRevealed(shouldReveal);
        // Отклик только на открытии: закрытие — возврат в исходное, там
        // «щёлкать» нечему.
        if (shouldReveal) hapticDrop();
        // Отскок — только если жест сам нёс инерцию (§4): брошенная строка
        // имеет право чуть перелететь и вернуться, аккуратно доведённая —
        // нет. Скорость пальца передаётся пружине как начальная (§5), шва
        // между жестом и анимацией не остаётся.
        const flick = absVel > SWIPE_VEL;
        spring.animateTo(shouldReveal ? -ACTION_W : 0, -vel, {
          response: flick ? 0.35 : 0.3,
          damping: flick ? 0.78 : 1,
        });
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
    <div
      style={{ position: "relative", overflow: "hidden" }}
      // Разделительная линия переехала СЮДА со строки: строка уезжает при
      // свайпе и уносила линию с собой, поэтому под открывшейся кнопкой
      // линия обрывалась (владелец 19.08.2026: «скольжение идёт не по
      // разделительной линии»). На обёртке она неподвижна и идёт через всю
      // ширину, а кнопка заканчивается на 1px выше неё.
      className="-mx-4 border-b border-stroke/50"
    >
      {/* Действие под свайпом — синий «редактировать» (был teal-check у
          завершения; teal и вообще «готово»-семантика тут неуместны, это
          другое действие). */}
      {/* Кнопка «изменить» под строкой. Именно КНОПКА, а не декоративная
          подложка: теперь действие выполняет нажатие на неё, а свайп лишь
          открывает её. pointerEvents включается только когда строка
          приоткрыта, иначе невидимый слой перехватывал бы тапы по строке. */}
      <button
        ref={actionRef}
        onClick={(e) => {
          e.stopPropagation();
          setRevealed(false);
          spring.animateTo(0, 0);
          navigate(`/task/${task.id}/edit`);
        }}
        aria-label="Изменить задачу"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          // bottom: 0 — кнопка упирается ПРЯМО в разделительную линию,
          // без зазора (владелец 19.08.2026: «на синем видно линию и потом
          // ещё пару пикселей черноты — скольжение идёт не по ней»). Сама
          // линия живёт на обёртке и проходит под кнопкой непрерывно,
          // поэтому перекрыть её кнопка не может. Замер до: 3 физических
          // пикселя фона между кромкой кнопки и линией.
          bottom: 0,
          // Ширина — ровно кнопка, а не вся строка: при движении синим
          // заливало всё полотно, а должно «открываться» только окошко
          // кнопки, как выдвижной ящик под строкой.
          width: ACTION_W,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "var(--color-blue)",
          // Тень внутрь от левого края — кнопка читается лежащей НИЖЕ
          // строки, а строка — крышкой, которая её открывает.
          boxShadow:
            "inset 10px 0 14px -8px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.08)",
          pointerEvents: "none",
        }}
      >
        <Icon name="edit" size={22} className="text-white" />
      </button>

      <div
        ref={rowRef}
        onPointerDown={onPointerDown}
        // bg-bg на САМОМ едущем слое, а не только на кнопке внутри:
        // .tap-row при нажатии подменяет фон на rgba(255,255,255,.04) —
        // полупрозрачный, — и сквозь него просвечивала синяя кнопка,
        // лежащая под строкой. Владелец 19.08.2026: «мне достаточно просто
        // нажать, и происходит сразу же сдвиг этой карточки» — сдвига на
        // самом деле не было, но выглядело именно так. Непрозрачный слой
        // под нажимаемой кнопкой закрывает подложку при любом её состоянии.
        className="bg-bg"
        // Тень от правого края строки — вторая половина того же эффекта:
        // строка «нависает» над открывшейся кнопкой.
        style={{ willChange: "transform", boxShadow: "6px 0 12px rgba(0,0,0,0.55)" }}
      >
        <button
          onClick={() => {
            // Строка приоткрыта — первый тап её закрывает, а не открывает
            // задачу: иначе промахнуться мимо кнопки значило бы всё равно
            // куда-то провалиться.
            if (revealed) {
              setRevealed(false);
              spring.animateTo(0, 0);
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
          className="tap-row w-full flex items-start gap-3 pt-[9px] pb-3 px-4 bg-bg text-left"
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
            {/* Проект — САМОЙ ВЕРХНЕЙ строкой, над названием задачи, и
                одинаково во всех представлениях: решётка плюс цветной
                текст, без заливки (владелец 19.08.2026: «почему в списке
                одна метка, а на доске другая? пусть везде будет решётка и
                название, в самом верху, без заливки — просто цветной
                текст»). Раньше здесь была пилюля с подложкой и без
                решётки, а на доске — с решёткой, и одна задача выглядела
                в двух местах по-разному. */}
            {hasProjectBadge && (
              <div
                className="mb-0.5 inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] font-medium"
                style={{ color: task.project_color || "#A6A6A6" }}
              >
                <Icon name="hash" size={10} className="shrink-0" />
                <span className="truncate">{task.project_name}</span>
              </div>
            )}
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
                {/* Проект отсюда убран — он теперь строкой над названием,
                    см. выше. */}
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
