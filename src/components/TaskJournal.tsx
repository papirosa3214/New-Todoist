// ═══════════ TASK JOURNAL — agent-work protocol UI (AGENT-PROTOCOL.md) ═══════════
// Everything TaskDetailScreen needs to show "what an agent did with this
// task" and let the owner act on it, in one file (the file-boundary rules
// for this wave only allow touching TaskDetailScreen.tsx + api/tasks.ts,
// plus one new component file — this is that file):
//
//   - AgentStatusRow   — header pill: работает / на проверке / заблокировано
//                        / пропал, with "N мин назад" or the stale warning.
//   - AgentOwnerActions — «Принять» / «Вернуть на доработку» / «Ответить и
//                        вернуть в работу» (для заблокированной) / «Вернуть
//                        в ожидание», visible only to the task's creator,
//                        only when the current agent_state makes them
//                        relevant.
//   - TaskFeed         — the единая лента: task.comments and task.events
//                        merged into one chronological list. Comments render
//                        as the existing full cards; journal rows render as
//                        one muted, compact, human-language line each — see
//                        describeEvent() below for the wording rules.
//
// No new colors/spacing/fonts: every class here already exists elsewhere in
// the app (bg-card/bg-card2 rows, text-sub/text-dim/text-coral, the 16/12/8/4
// padding scale, tap-scale/tap-fade for touch feedback, the Dialog.tsx/
// RescheduleSheet.tsx bottom-sheet shape for the "Вернуть на доработку"
// comment prompt).
import { useMemo, useState } from "react";
import { Avatar, Button, ErrorBanner, Icon, SheetHandle } from "./UI";
import { useDialog } from "./Dialog";
import { useSetAgentState, useUpdateTask } from "../api/tasks";
import { useAddComment } from "../api/comments";
import { useAgents } from "../api/agents";
import { useProjects } from "../api/projects";
import { PRIORITIES } from "../lib/priority";
import { AttachmentView } from "./AttachmentView";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { formatDueLabel, formatRelativeTime } from "../lib/date";
import { useBottomSheet } from "../lib/useBottomSheet";
import type { ApiComment, ApiTask, ApiTaskEvent } from "../api/types";

// ═══════════ STATUS ROW ═══════════

const AGENT_STATE_META: Record<
  "in_progress" | "blocked" | "review",
  { label: string; color: string }
> = {
  // text-green, не text-teal (правка 18.08.2026) — «Агент работает» здесь
  // должен быть тем же единым зелёным, что done/running в SubtaskFeed, а
  // не отдельным оттенком: Максим явно указал красить состояние именно
  // тут, в карточке задачи, не бейдж AGENT_TAG_META в списке/канбане
  // (UI.tsx) — его отдельный text-teal сознательно не тронут.
  in_progress: { label: "Агент работает", color: "text-green" },
  blocked: {
    label: "Заблокировано — нужны ваши действия",
    color: "text-orange",
  },
  review: { label: "На проверке — ждёт вашей приёмки", color: "text-blue" },
};

export function AgentStatusRow({ task }: { task: ApiTask }) {
  if (!task.agent_state) return null;

  // "Агент пропал" — aренда истекла while still nominally in_progress.
  // Computed server-side (agent_stale), never re-derived here — see
  // server/src/agentState.ts isStale and its "never trust a stale
  // client-cached value" note on ApiTask.agent_stale.
  if (task.agent_state === "in_progress" && task.agent_stale) {
    return (
      <div className="flex items-center gap-3 py-3 px-4 bg-coral/12 rounded-xl">
        <Icon name="bot" size={18} className="text-coral shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[14px] text-coral font-medium">Агент пропал</p>
          <p className="text-[12px] text-coral/80">
            Аренда истекла — последний сигнал:{" "}
            {task.agent_heartbeat_at
              ? formatRelativeTime(task.agent_heartbeat_at)
              : "неизвестно"}
          </p>
        </div>
      </div>
    );
  }

  const meta = AGENT_STATE_META[task.agent_state];
  return (
    <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
      <Icon name="bot" size={18} className={`${meta.color} shrink-0`} />
      <span className={`text-[14px] flex-1 ${meta.color}`}>{meta.label}</span>
      {task.agent_state === "in_progress" && task.agent_heartbeat_at && (
        <span className="text-[12px] text-dim shrink-0">
          {formatRelativeTime(task.agent_heartbeat_at)}
        </span>
      )}
    </div>
  );
}

// ═══════════ OWNER ACTIONS ═══════════
// Visible only to task.creator_id (checked by the caller, `isOwner`), and
// only for the agent_state that makes each action meaningful — see the
// transition matrix in AGENT-PROTOCOL.md:
//   review → completed          (только владелец — «приёмка»)
//   review → in_progress        (только владелец, комментарий обязателен)
//   любое  → NULL                (владелец — «снять с агента»)

export function AgentOwnerActions({
  task,
  isOwner,
}: {
  task: ApiTask;
  isOwner: boolean;
}) {
  const updateTask = useUpdateTask();
  const setAgentState = useSetAgentState();
  const addComment = useAddComment(task.id);
  const [returning, setReturning] = useState(false);
  // Для заблокированной задачи тот же лист собирает не «что доработать», а
  // ответ на вопрос агента — отсюда разный заголовок и разный обработчик.
  const [answering, setAnswering] = useState(false);
  const [comment, setComment] = useState("");
  // Подтверждение приёмки, когда шаги не закрыты (см. handleAccept) —
  // тем же диалогом, что и остальные подтверждения в приложении.
  const { confirm, dialog } = useDialog();

  // Незакрытые шаги на момент приёмки. Владелец 19.08.2026: нажал
  // «Принять» — задача закрылась, «при том что у меня одна подзадача в
  // итоге болтается». Молча закрывать задачу с незавершёнными шагами
  // нельзя: на доске и в отчётах она станет выполненной, а работа по ней
  // — нет.
  const openSubtasks = (task.subtasks || []).filter((st) => !st.done);

  const handleAccept = useGuardedCallback(async () => {
    if (openSubtasks.length > 0) {
      const ok = await confirm({
        title: `Закрыть задачу? Не выполнено шагов: ${openSubtasks.length}`,
        description:
          openSubtasks.length === 1
            ? `Шаг «${openSubtasks[0].title}» останется невыполненным, а задача уйдёт в готовые.`
            : "Эти шаги останутся невыполненными, а задача уйдёт в готовые.",
        confirmLabel: "Всё равно закрыть",
        cancelLabel: "Не закрывать",
      });
      if (!ok) return;
    }
    await updateTask.mutateAsync({ id: task.id, status: "completed" });
  });

  // state:null — это НЕ «снять исполнителя» (assignee_id не трогается,
  // задача остаётся на агенте), а сброс рабочего состояния: карточка снова
  // ждёт, и агент может взяться за неё заново. Кнопка называлась «Снять с
  // агента» и этим сбивала с толку — из заблокированной задачи было
  // непонятно, чем вообще её вернуть (Максим, 18.08.2026).
  const handleRelease = useGuardedCallback(async () => {
    await setAgentState.mutateAsync({ id: task.id, state: null });
  });

  // Ответ на блокировку. Порядок важен: СНАЧАЛА снять blocked, ПОТОМ
  // комментарий. Будильник (taskflow-trigger) просыпается по уведомлению о
  // комментарии и тут же перечитывает задачу — если она в этот момент ещё
  // blocked, он пройдёт мимо («заблокирована, ждёт владельца») и ответ
  // повиснет без движения.
  const handleAnswer = useGuardedCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    await setAgentState.mutateAsync({ id: task.id, state: null });
    await addComment.mutateAsync({ text: trimmed });
    setAnswering(false);
    setComment("");
  });

  const handleReturn = useGuardedCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    await setAgentState.mutateAsync({
      id: task.id,
      state: "in_progress",
      comment: trimmed,
    });
    setReturning(false);
    setComment("");
  });

  if (!isOwner || !task.agent_state) return null;

  return (
    <div className="mb-4">
      <div className="space-y-2">
        {task.agent_state === "review" && (
          <Button variant="primary" onClick={handleAccept}>
            <Icon name="check" size={16} />
            Принять
          </Button>
        )}
        {task.agent_state === "review" && (
          <Button variant="secondary" onClick={() => setReturning(true)}>
            <Icon name="sync" size={16} />
            Вернуть на доработку
          </Button>
        )}
        {task.agent_state === "blocked" && (
          <Button variant="primary" onClick={() => setAnswering(true)}>
            <Icon name="sync" size={16} />
            Ответить и вернуть в работу
          </Button>
        )}
        <Button variant="outline" onClick={handleRelease}>
          <Icon name="x" size={16} />
          Вернуть в ожидание
        </Button>
      </div>
      <ErrorBanner
        error={updateTask.error || setAgentState.error || addComment.error}
        fallback="Не удалось изменить состояние задачи"
        variant="block"
        className="mt-2"
      />

      {answering && (
        <ReturnToWorkSheet
          open={answering}
          title="Ответить агенту"
          hint="Задача выйдет из блокировки, а ответ уйдёт агенту — он продолжит с этого места."
          placeholder="Например: 42 записи слей в основную базу, старую не трогай…"
          value={comment}
          onChange={setComment}
          busy={setAgentState.isPending || addComment.isPending}
          onCancel={() => {
            setAnswering(false);
            setComment("");
          }}
          onSubmit={handleAnswer}
        />
      )}

      {dialog}

      {returning && (
        <ReturnToWorkSheet
          open={returning}
          value={comment}
          onChange={setComment}
          busy={setAgentState.isPending}
          onCancel={() => {
            setReturning(false);
            setComment("");
          }}
          onSubmit={handleReturn}
        />
      )}
    </div>
  );
}

// Bottom sheet collecting the mandatory comment for "Вернуть на доработку"
// (POST /state {state:'in_progress', comment} — server 400s without one).
// Same visual language as Dialog.tsx / RescheduleSheet.tsx: black scrim,
// bg-card rounded-t-[20px] panel sliding up, X-closes / ✓-confirms header.
function ReturnToWorkSheet({
  open,
  value,
  onChange,
  onCancel,
  onSubmit,
  busy,
  // Тот же лист обслуживает два сценария владельца — «вернуть на доработку»
  // (из review) и «ответить агенту» (из blocked). Разница только в словах,
  // поэтому не плодим второй компонент.
  title = "Вернуть на доработку",
  hint = "Без комментария сервер не примет возврат — опишите, что нужно поправить.",
  placeholder = "Например: не хватает шагов для сценария «просрочено»…",
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  title?: string;
  hint?: string;
  placeholder?: string;
}) {
  // §3 Interruptibility, §5 Velocity handoff, §7 Spatial consistency
  const sheet = useBottomSheet({ open, onClose: onCancel });

  if (!sheet.mounted) return null;

  return (
    <div
      className="fixed left-0 right-0 z-50 flex flex-col justify-end"
      onClick={onCancel}
      // Не inset-0, а РОВНО ВИДИМАЯ ОБЛАСТЬ (--vv-top/--vv-height пишет
      // useVisualViewportInset из window.visualViewport). `inset-0`
      // растягивает шторку по layout-вьюпорту, а он на iOS при открытии
      // клавиатуры не меняется — низ шторки оказывается под клавиатурой, и
      // её приходилось поднимать вычисленной высотой. Владелец 20.08.2026
      // после проверки на телефоне: «клавиатура выехала, и ровно в том же
      // месте выехало окно — не решено». Так и есть: вычисление опирается
      // на разность с innerHeight, а она в его режиме схлопывается в ноль.
      // Видимая область такой зависимости не имеет: шторка живёт внутри
      // неё, и места «под клавиатурой» у неё физически нет.
      style={{
        top: "var(--vv-top, 0px)",
        height: "var(--vv-height, 100dvh)",
      }}
    >
      {/* Scrim: opacity animated by useBottomSheet spring */}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-t-[20px] px-4"
        onClick={(e) => e.stopPropagation()}
        // Лист поднимается НАД экранной клавиатурой. Без этого он вставал
        // ровно на её место и полностью её перекрывал: поле для
        // комментария видно, а печатать нечем (владелец 19.08.2026: «она
        // чётко ровно в размер клавиатуры вылезла»).
        //
        // Переменная именно --kb-height, а не --kb-inset (20.08.2026,
        // владелец пожаловался повторно: «окошко открывается ровно там,
        // где клавиатура, писать нечем»). Разница ровно та же, что уже
        // разобрана для MicKeyboardBar: --kb-inset вычитает vv.offsetTop,
        // и это верно для элементов В ПОТОКЕ документа — они физически
        // панорамируются вместе со страницей. Шторка же `position: fixed`,
        // она крепится к layout-вьюпорту и в панорамировании не участвует;
        // а autoFocus на textarea WebKit как раз панорамированием и
        // сопровождает. Получался двойной учёт: лист садился на offsetTop
        // глубже в зону клавиатуры. --kb-height = innerHeight − vv.height,
        // чистая высота клавиатуры, без поправки на пан.
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
        }}
      >
        {/* Handle: drag target for dismiss gesture */}
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-2">
          <button
            onClick={onCancel}
            aria-label="Отмена"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          {/* Заголовок шторки — 17px, как заголовок вторичного экрана
              (ScreenHeader variant="compact"): шторка это тот же уровень
              навигации. 16px здесь был сиротой вне шкалы — в проекте 16px
              значит «поле ввода, защита от автозума iOS», см. index.css. */}
          <h3 className="text-[17px] font-semibold text-text">{title}</h3>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || busy}
            aria-label="Отправить"
            className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-white" />
          </button>
        </div>
        <p className="text-[13px] text-sub mb-2 px-1">{hint}</p>
        <textarea
          autoFocus
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none resize-none mb-3"
        />
      </div>
    </div>
  );
}

// ═══════════ FEED — comments + journal, merged ═══════════

type FeedRow =
  | { kind: "comment"; ts: string; comment: ApiComment }
  | { kind: "event"; ts: string; event: ApiTaskEvent };

// The claim endpoint always writes a 'claimed' row immediately followed by
// a 'state_changed' (agent_state: null → in_progress) row in the same
// transaction (server/src/routes/agent-state.ts) — both say the same
// thing to a human. Rather than render both, drop the state_changed twin
// and keep just 'claimed' (its wording — "взял задачу в работу" — already
// covers it).
function isClaimTwin(event: ApiTaskEvent, prev: ApiTaskEvent | undefined) {
  return (
    !!prev &&
    prev.kind === "claimed" &&
    prev.actor_id === event.actor_id &&
    event.kind === "state_changed" &&
    event.field === "agent_state" &&
    event.to_value === "in_progress"
  );
}

function buildFeed(task: ApiTask): FeedRow[] {
  const comments: FeedRow[] = (task.comments ?? []).map((c) => ({
    kind: "comment",
    ts: c.created_at,
    comment: c,
  }));
  const rawEvents = task.events ?? [];
  const events: FeedRow[] = rawEvents
    .filter((e, i) => !isClaimTwin(e, rawEvents[i - 1]))
    .map((e) => ({ kind: "event", ts: e.created_at, event: e }));
  // Array#sort is stable — on a tie (same second) this keeps comments
  // ahead of events, since `comments` was concatenated first.
  // .reverse() at the end (Максим 18.08.2026: «самые актуальные вверху,
  // самые неактуальные внизу» — не листать до конца, чтобы увидеть
  // последнее), not a flipped comparator: reversing the whole
  // already-sorted (oldest-first, comment-before-event-on-a-tie) array
  // keeps that same tie order flipped consistently too — the event now
  // sits above the comment that explains it, which still reads naturally
  // top-to-bottom-is-newest-to-oldest ("сдано на проверку" first, its own
  // explanation right under it).
  return [...comments, ...events]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .reverse();
}

const AGENT_STATE_WORD: Record<string, string> = {
  in_progress: "в работе",
  blocked: "заблокирована",
  review: "на проверке",
};

function describeAgentStateChange(
  from: string | null,
  to: string | null,
  actor: string,
): string {
  if (to === "in_progress" && from === "blocked") {
    return `${actor} вернулся к работе после блокировки`;
  }
  if (to === "in_progress" && from === "review") {
    return `${actor} вернул задачу на доработку`;
  }
  if (to === "in_progress") {
    return `${actor} взял задачу в работу`;
  }
  if (to === "review") {
    return `${actor} сдал задачу на проверку`;
  }
  if (to === "blocked") {
    return `${actor} заблокировал задачу — нужны действия владельца`;
  }
  if (to === null) {
    return `${actor} снял задачу с агента`;
  }
  const fromWord = from ? (AGENT_STATE_WORD[from] ?? from) : "не взята";
  const toWord = to ? (AGENT_STATE_WORD[to] ?? to) : "снята с агента";
  return `${actor}: ${fromWord} → ${toWord}`;
}

// Справочники для расшифровки field_changed: id исполнителя и проекта сами
// по себе человеку ничего не говорят, а имя лежит в других запросах.
// Приходит из TaskFeed (useAgents/useProjects) — если справочник ещё не
// загружен или запись старая и того пользователя/проекта уже нет, строка
// честно скажет «снят»/«убран», а не покажет сырой идентификатор.
type NameLookup = {
  userName: (id: string | null) => string | null;
  projectName: (id: string | null) => string | null;
};

function describeFieldChange(e: ApiTaskEvent, actor: string, look: NameLookup) {
  if (e.field === "assignee_id") {
    const to = look.userName(e.to_value);
    if (!e.to_value) return `${actor} снял исполнителя`;
    return `${actor} назначил исполнителем: ${to ?? "другого участника"}`;
  }
  if (e.field === "due_date") {
    if (!e.to_value) return `${actor} убрал срок`;
    return `${actor} поставил срок: ${formatDueLabel(e.to_value)}`;
  }
  if (e.field === "priority") {
    const p = PRIORITIES.find((x) => String(x.key) === String(e.to_value));
    return `${actor} сменил приоритет: ${p ? p.name.toLowerCase() : (e.to_value ?? "без приоритета")}`;
  }
  if (e.field === "project_id") {
    const to = look.projectName(e.to_value);
    if (!e.to_value) return `${actor} убрал задачу из проекта`;
    return `${actor} перенёс задачу в проект: ${to ?? "другой"}`;
  }
  if (e.field === "title") return `${actor} переименовал задачу`;
  return `${actor}: задача обновлена`;
}

function describeEvent(e: ApiTaskEvent, look: NameLookup): string {
  const actor = e.actor_name || "Система";
  if (e.kind === "claimed") return `${actor} взял задачу в работу`;
  if (e.kind === "state_changed" && e.field === "agent_state") {
    return describeAgentStateChange(e.from_value, e.to_value, actor);
  }
  if (e.kind === "state_changed" && e.field === "status") {
    if (e.to_value === "completed") return `${actor} принял задачу`;
    if (e.to_value === "active") return `${actor} вернул задачу в работу`;
  }
  if (e.kind === "field_changed") return describeFieldChange(e, actor, look);
  if (e.kind === "task_created") return `${actor} создал задачу`;
  if (e.kind === "subtasks_seeded") {
    return `${actor} добавил шаги: ${e.to_value ?? ""}`.trim();
  }
  if (e.kind === "subtask_added") return `${actor} добавил шаг: ${e.to_value}`;
  if (e.kind === "subtask_done") return `${actor} выполнил шаг: ${e.to_value}`;
  if (e.kind === "subtask_undone") {
    return `${actor} снял отметку с шага: ${e.to_value}`;
  }
  if (e.kind === "subtask_renamed") {
    return `${actor} переименовал шаг: ${e.from_value} → ${e.to_value}`;
  }
  if (e.kind === "subtask_removed") {
    return `${actor} удалил шаг: ${e.from_value}`;
  }
  if (e.kind === "subtask_review") {
    return `${actor} сдал шаг на проверку: ${e.to_value}`;
  }
  if (e.kind === "subtask_returned") {
    return `${actor} вернул шаг на доработку: ${e.to_value}`;
  }
  if (e.kind === "description_changed") return `${actor} изменил описание`;
  if (e.kind === "labels_changed") return `${actor} изменил метки`;
  // Forward-compatible fallback for journal kinds this wave doesn't render
  // specially (field_changed/subtask_*/label_*/comment_added — wave C) —
  // still Russian, still no raw "kind field→value" leaking through.
  return `${actor}: задача обновлена`;
}

function JournalLine({
  event,
  look,
}: {
  event: ApiTaskEvent;
  look: NameLookup;
}) {
  return (
    <div className="flex items-center gap-2 px-1 py-1.5">
      <span className="w-1 h-1 rounded-full bg-dim shrink-0" />
      <span className="flex-1 min-w-0 text-[12px] text-dim">
        {describeEvent(event, look)}
      </span>
      <span className="text-[11px] text-dim shrink-0">
        {formatRelativeTime(event.created_at)}
      </span>
    </div>
  );
}

function CommentCard({ comment }: { comment: ApiComment }) {
  return (
    <div className="bg-card rounded-2xl p-3">
      <div className="flex items-center gap-2 mb-1">
        <Avatar
          initials={comment.user_initials || "?"}
          color={comment.user_color || "#A6A6A6"}
          avatar_url={comment.user_avatar_url}
          size={20}
        />
        <span className="text-[13px] font-medium">
          {comment.user_name || "Неизвестный"}
        </span>
        <span className="text-[11px] text-dim ml-auto">
          {formatRelativeTime(comment.created_at)}
        </span>
      </div>
      {comment.text && (
        <p className="text-[14px] text-sub whitespace-pre-wrap">
          {comment.text}
        </p>
      )}
      {/* Приложенные файлы: картинки показываются превью, документы —
          строкой с именем и размером (AttachmentView.tsx). Комментарий
          может состоять из одних файлов — тогда текста выше просто нет. */}
      {comment.attachments?.map((att) => (
        <AttachmentView key={att.id} attachment={att} />
      ))}
    </div>
  );
}

export function TaskFeed({ task }: { task: ApiTask }) {
  const feed = buildFeed(task);
  // Справочники для строк вида «назначил исполнителем: Клод» — журнал
  // хранит идентификаторы, а имена живут в этих двух запросах (оба уже
  // закешированы react-query: экран агентов и список проектов их и так
  // тянут). Пока не загрузились — describeFieldChange даёт нейтральную
  // формулировку, сырой id в ленту не попадает.
  const { data: agents } = useAgents();
  const { data: projects } = useProjects();
  const look: NameLookup = useMemo(
    () => ({
      userName: (id) =>
        id ? (agents?.find((a) => a.id === id)?.name ?? null) : null,
      projectName: (id) =>
        id ? (projects?.find((p) => p.id === id)?.name ?? null) : null,
    }),
    [agents, projects],
  );

  if (feed.length === 0) {
    return (
      <div className="bg-card rounded-2xl p-4 text-center text-[13px] text-dim mb-2">
        Лента пуста — ни комментариев, ни событий
      </div>
    );
  }

  return (
    <div className="space-y-1.5 mb-2">
      {feed.map((row) =>
        row.kind === "comment" ? (
          <CommentCard key={`c-${row.comment.id}`} comment={row.comment} />
        ) : (
          <JournalLine
            key={`e-${row.event.id}`}
            event={row.event}
            look={look}
          />
        ),
      )}
    </div>
  );
}
