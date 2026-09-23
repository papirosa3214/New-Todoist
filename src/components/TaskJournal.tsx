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
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorBanner, Icon, SheetHandle } from "./UI";
import { useDialog } from "./Dialog";
import { useRunTaskAgent, useSetAgentState, useUpdateTask } from "../api/tasks";
import { useAddComment } from "../api/comments";
import { useAgents } from "../api/agents";
import { useProjects } from "../api/projects";
import { PRIORITIES } from "../lib/priority";
import { AttachmentView } from "./AttachmentView";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { formatDueLabel, formatRelativeTime, formatAbsoluteTime } from "../lib/date";
import { useBottomSheet } from "../lib/useBottomSheet";
import { MicKeyboardBar } from "./MicKeyboardBar";
import { MicOverlay } from "./MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { combineDictatedText } from "../lib/dictationParser";
import {
  useTaskActivity,
  fetchRecentActivity,
  type ActivityAction,
} from "../lib/useTaskActivity";
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

// Команда для терминала — зайти в того же двойника, который ведёт задачу
// (`claude --resume <session-id>`, тот же флаг, каким сам будильник
// TaskFlow продолжает свою сессию — server/scripts/trigger.py). Копируется
// одной кнопкой прямо из карточки, руками ID не набирать. Показывается,
// только пока сессия известна (agent_session_id) — у задач, взятых до
// привязки к сессии, поле пустое, кнопки нет.
function ResumeSessionButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(`claude --resume ${sessionId}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="tap-scale shrink-0 flex items-center justify-center h-7 w-7 rounded-lg bg-card2 text-dim"
      title={
        copied ? "Скопировано" : `Скопировать: claude --resume ${sessionId}`
      }
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
}

// «N с назад» для отметки времени живой строки — своя, помельче
// formatRelativeTime (та начинается с минут: «5 мин. назад», «только
// что»), а строка обновляется каждые пару секунд и должна это показывать.
function activityAgoLabel(atMs: number | null, nowMs: number): string {
  if (!atMs) return "";
  const diffSec = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (diffSec < 60) return `${diffSec} с назад`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин. назад`;
  return `${Math.round(diffMin / 60)} ч. назад`;
}

// Живая строка «чем занят агент прямо сейчас», под плашкой статуса —
// см. tickets/live-line-ui. Заменяется на месте (не копится), тап
// раскрывает последние действия из серверного буфера. Рендерится только
// когда AgentStatusRow передаёт activity с непустым text — сама решает,
// стоит ли вообще её монтировать (agent_state !== in_progress / stale —
// не стоит, см. isLive в AgentStatusRow).
function AgentActivityLine({
  taskId,
  activity,
}: {
  taskId: string;
  activity: {
    text: string | null;
    actorName: string | null;
    at: number | null;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const [actions, setActions] = useState<ActivityAction[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Тикает раз в 2 с — та же частота, с которой сервер вообще может
  // прислать новую строку (троттлинг в activity.ts), чаще смысла нет.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    fetchRecentActivity(taskId)
      .then((a) => {
        if (!cancelled) setActions(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, taskId]);

  if (!activity.text) return null;

  // Сервер склеивает строку как «шаг · действие» (activity.ts, buildText).
  // Свёрнутой видна одна строка, и в неё влезает не всё: название шага
  // длиннее действия и съедало её целиком — на экране оставалось «Вернуть
  // потерянные хвосты 113 обр…», то есть ровно то, что и так видно в списке
  // подзадач ниже, а САМО действие обрезалось. Поэтому режем обратно:
  // действие — крупно и основным цветом, шаг — мелкой строкой под ним.
  const sep = activity.text.indexOf(" · ");
  const stepTitle = sep > 0 ? activity.text.slice(0, sep) : null;
  const doingNow = sep > 0 ? activity.text.slice(sep + 3) : activity.text;

  return (
    <div className="rounded-xl bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="tap-fade w-full flex items-start gap-2 py-2.5 px-4 text-left"
      >
        <Icon name="bot" size={13} className="text-teal shrink-0 mt-0.5" />
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          {/* Подпись: без неё непонятно, что это за панель и зачем она. */}
          <span className="text-[10px] uppercase tracking-wide text-dim">
            Чем занят агент
          </span>
          {/* Полностью, с переносами — не truncate: Максим 26.08.2026,
              «полтора слова влазит и всё», обрезанная фраза бесполезна.
              Фразы короткие по построению (сервер режет: наблюдатель до
              70 символов, шаг до 40) — простыни тут не бывает. */}
          <span className="text-[13px] text-text leading-snug break-words">
            {doingNow}
          </span>
          {stepTitle && (
            <span className="text-[11px] text-dim break-words">
              по шагу: {stepTitle}
            </span>
          )}
        </span>
        <span className="text-[11px] text-dim shrink-0 mt-0.5">
          {activityAgoLabel(activity.at, now)}
        </span>
        <Icon
          name="chevronDown"
          size={14}
          className={`text-dim shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-stroke px-4 py-2 flex flex-col gap-1 max-h-48 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wide text-dim pb-0.5">
            Последние действия
          </p>
          {actions.length === 0 ? (
            <p className="text-[12px] text-sub py-1">пока пусто</p>
          ) : (
            actions
              .slice()
              .reverse()
              .map((a, i) => (
                // text-sub, а не text-dim: здесь это основное содержимое, а
                // не фоновая подпись — приглушённым оно не читалось вовсе.
                // И break-words вместо truncate: у пути важен хвост с именем
                // файла, а обрезка съедала именно его.
                //
                // Печатаем a.text — ГОТОВУЮ фразу от сервера («разбирается в
                // src/lib/search.ts»). Раньше здесь был голый a.target, и
                // список выглядел выпиской из лога вызовов. Формулировка —
                // на сервере (describeAction), одна на всех потребителей.
                <p key={i} className="text-[12px] text-sub break-words">
                  {a.text || a.target}
                </p>
              ))
          )}
        </div>
      )}
    </div>
  );
}

export function AgentStatusRow({ task }: { task: ApiTask }) {
  // Хук обязан звать безусловно (правила React) — «есть ли смысл слушать»
  // передаётся аргументом, а не оборачивает вызов. Строка живая, только
  // пока задача реально in_progress и не пропала: у «пропал» и у прочих
  // agent_state своя ветка ниже, там строке взяться неоткуда.
  const isLive = task.agent_state === "in_progress" && !task.agent_stale;
  const activity = useTaskActivity(task.id, isLive);

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
        {task.agent_session_id && (
          <ResumeSessionButton sessionId={task.agent_session_id} />
        )}
      </div>
    );
  }

  const meta = AGENT_STATE_META[task.agent_state];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
        <Icon name="bot" size={18} className={`${meta.color} shrink-0`} />
        <span className={`text-[14px] flex-1 ${meta.color}`}>{meta.label}</span>
        {task.agent_state === "in_progress" && task.agent_heartbeat_at && (
          <span className="text-[12px] text-dim shrink-0">
            {formatRelativeTime(task.agent_heartbeat_at)}
          </span>
        )}
        {task.agent_session_id && (
          <ResumeSessionButton sessionId={task.agent_session_id} />
        )}
      </div>
      {isLive && <AgentActivityLine taskId={task.id} activity={activity} />}
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
  const runAgent = useRunTaskAgent();
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

  // ⚠️ «Вернуть в ожидание» (сброс agent_state в null без комментария) —
  // УДАЛЕНО 21.08.2026 по решению Максима: «вообще убери логику этой
  // кнопки из кода, достаточно полноценной „вернуть на доработку", потому
  // что она содержит в себе комментарий; а эта абсолютно нелогичная,
  // лишняя загромождающая конструкция».
  //
  // Разбор, почему кнопка и правда была лишней: обе кнопки приводили к
  // одному — задача снова доступна, будильник тут же поднимает её, и берёт
  // её НОВАЯ сессия агента (прежняя не воскресает ни в одном случае).
  // Значит единственная реальная разница между ними — есть ли задание,
  // что доделать. «Вернуть в ожидание» отпускала задачу молча, и агент
  // брался заново, не зная, что было не так.
  //
  // Сброс состояния на уровне ПОДЗАДАЧ (TaskDetailScreen, onReturn /
  // onComment) это не затрагивает: там state:null идёт вместе с
  // комментарием, то есть ровно с тем заданием, которого здесь не было.

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

  // «Вернуть на доработку» ведёт себя по-разному в зависимости от того,
  // откуда возвращают, — и это не косметика, а разные переходы:
  //
  //  • из review — задача уходит обратно В РАБОТУ тем же запросом
  //    (state: 'in_progress' с обязательным комментарием), сессия агента
  //    сохраняется (сервер бережёт agent_session_id через COALESCE).
  //  • из in_progress — вернуть «в работу» то, что и так в работе, нельзя:
  //    сервер такой переход не пропускает (agentState.ts, матрица), да и
  //    смысла нет — задачу надо ОСВОБОДИТЬ, чтобы будильник поднял её
  //    заново. Поэтому здесь тот же путь, что у ответа на блокировку:
  //    сначала снять состояние, потом комментарий с заданием.
  //
  // Порядок вызовов во второй ветке (state ПЕРЕД comment) — тот же, что в
  // handleAnswer, и по той же причине: будильник просыпается по
  // уведомлению о комментарии и сразу перечитывает задачу. Успеет
  // прочитать её ещё занятой — пройдёт мимо, и ответ повиснет.
  const handleReturn = useGuardedCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    if (task.agent_state === "review") {
      await setAgentState.mutateAsync({
        id: task.id,
        state: "in_progress",
        comment: trimmed,
      });
    } else {
      await setAgentState.mutateAsync({ id: task.id, state: null });
      await addComment.mutateAsync({ text: trimmed });
    }
    setReturning(false);
    setComment("");
  });

  // Владельческие кнопки есть у сданной («Принять» / «Вернуть на
  // доработку»), у заблокированной («Ответить и вернуть в работу») и —
  // с 24.08.2026 — у ВЗЯТОЙ В РАБОТУ.
  //
  // Раньше последней ветки не было: считалось, что пока агент работает,
  // владельцу решать нечего. На практике вышло наоборот — именно там
  // карточка и залипала. Агент берёт задачу, сессия обрывается (или он
  // доделал, но не успел сдать), состояние остаётся «в работе» навсегда, и
  // у владельца на всём экране остаётся одна кнопка «Изменить», которая от
  // залипания не спасает. Слова Максима 24.08.2026: «остаются
  // заблокированными даже после выполнения задачи… отсутствует возможность
  // отправить задачу на доработку агенту, из-за чего карточка зависает».
  //
  // Кнопки те же самые, что у заблокированной, — новых сущностей не
  // заводим: вернуть на доработку с заданием или принять и закрыть.
  //
  // ⚠️ И только пока задача АКТИВНА. У закрытой карточки состояние агента
  // тоже может гореть — старым остатком на незакрытом шаге, который
  // поднимается роллапом (withAgentStale), — но обе кнопки там были бы
  // ложью: «Принять и закрыть» на уже закрытой задаче не проходит guard в
  // PATCH (status тот же самый) и не делает ничего. Кнопка, нажатие
  // которой ни к чему не приводит, — ровно то, на что Максим и жаловался.
  // У закрытой задачи свой путь: «Открыть задачу заново».
  const hasOwnerActions =
    task.status === "active" &&
    (task.agent_state === "review" ||
      task.agent_state === "blocked" ||
      task.agent_state === "in_progress");
  if (!isOwner || !hasOwnerActions) return null;

  // Агент пропал — аренда истекла (считает сервер, см. agent_stale). Работу
  // никто не ведёт, поэтому возврат на доработку здесь главное действие и
  // выглядит главным; пока агент жив — это вмешательство в идущую работу,
  // и кнопка остаётся второстепенной.
  const agentGone = task.agent_state === "in_progress" && task.agent_stale;

  return (
    <div className="mb-4">
      <div className="space-y-2">
        {task.agent_state === "review" && (
          <Button variant="primary" onClick={handleAccept}>
            <Icon name="check" size={16} />
            Принять и закрыть задачу
          </Button>
        )}
        {task.agent_state === "review" && (
          <Button variant="secondary" onClick={() => setReturning(true)}>
            <Icon name="sync" size={16} />
            Вернуть на доработку
          </Button>
        )}
        {task.agent_state === "blocked" && (
          <>
            <Button variant="primary" onClick={() => setAnswering(true)}>
              <Icon name="sync" size={16} />
              Ответить и вернуть в работу
            </Button>
            <Button variant="secondary" onClick={handleAccept}>
              <Icon name="check" size={16} />
              Принять и закрыть задачу
            </Button>
          </>
        )}
        {task.agent_state === "in_progress" && (
          <>
            <Button
              variant={agentGone ? "primary" : "secondary"}
              onClick={() => setReturning(true)}
            >
              <Icon name="sync" size={16} />
              Вернуть на доработку
            </Button>
            <Button variant="secondary" onClick={handleAccept}>
              <Icon name="check" size={16} />
              Принять и закрыть задачу
            </Button>
          </>
        )}
        {task.assignee_id && (
          <Button
            variant="secondary"
            onClick={() => runAgent.mutate({ id: task.id, mode: "executor" })}
            disabled={runAgent.isPending}
          >
            <Icon name="play" size={16} />
            Запустить исполнителя
          </Button>
        )}
        {task.agent_state === "review" && (
          <Button
            variant="secondary"
            onClick={() => runAgent.mutate({ id: task.id, mode: "reviewer" })}
            disabled={runAgent.isPending}
          >
            <Icon name="check" size={16} />
            Отправить на проверку верификатору
          </Button>
        )}
      </div>
      <ErrorBanner
        error={updateTask.error || setAgentState.error || runAgent.error || addComment.error}
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
          error={setAgentState.error || addComment.error}
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
          // Из работы возврат идёт двумя запросами (см. handleReturn), и
          // «отправляется» лист должен оставаться, пока не прошли оба.
          busy={setAgentState.isPending || addComment.isPending}
          error={setAgentState.error || addComment.error}
          // Из review задача возвращается тому же агенту и продолжается с
          // места; из работы — освобождается и берётся заново. Обещать
          // владельцу одно и то же в двух разных случаях нельзя.
          hint={
            task.agent_state === "review"
              ? undefined
              : agentGone
                ? "Задача освободится, а ваш комментарий станет заданием: будильник поднимет её заново."
                : "Задача освободится, а ваш комментарий станет заданием — её возьмёт следующий заход агента."
          }
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
// bg-card rounded-sheet-top panel sliding up, X-closes / ✓-confirms header.
function ReturnToWorkSheet({
  open,
  value,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
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
  /** Ошибка последней попытки отправки (setAgentState/addComment) — баннер
   *  выше в AgentOwnerActions рисуется СНАРУЖИ этой шторки, а она —
   *  fixed z-50 с полноэкранным scrim: тот баннер физически скрыт, пока
   *  шторка открыта, и провал запроса выглядел бы как «нажал — ничего не
   *  произошло» (owner 2026-08-20, тот же симптом что и потерянный клик —
   *  разные причины, одно и то же впечатление). Дублируем ошибку сюда. */
  error?: unknown;
  title?: string;
  hint?: string;
  placeholder?: string;
}) {
  // §3 Interruptibility, §5 Velocity handoff, §7 Spatial consistency
  const sheet = useBottomSheet({ open, onClose: onCancel });

  // Микрофон — та же плавающая кнопка над клавиатурой, что у поля
  // комментария в ленте (TaskDetailScreen) и у формы задачи: единообразие
  // подсказки «есть текстовое поле — рядом есть микрофон» (owner
  // 2026-08-20: «нативная клавиатура — пропадает мой микрофончик, который
  // должен всегда быть у клавиатуры»). textarea открывается с autoFocus,
  // так что панель должна быть на экране с первого кадра, а не только
  // после явного onFocus — отсюда initial state true, а не false.
  const [focused, setFocused] = useState(true);
  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text } = await transcribeAudio.mutateAsync(blob);
      onChange(combineDictatedText(value, text));
    } catch {
      // Причина уже в transcribeAudio.error — её показывает ErrorBanner.
    } finally {
      mic.finish();
    }
  });
  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  })();

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
        className="relative bg-card rounded-sheet-top px-4"
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
            type="button"
            // preventDefault на mousedown: тап при открытой клавиатуре иначе
            // сперва уводит фокус с textarea, клавиатура съезжает, шторка
            // переезжает — и кнопка уходит из-под пальца между touchstart и
            // touchend, click не приходит. Тот же приём, что в MicKeyboardBar
            // и в ReplyForm (SubtaskFeed.tsx).
            onMouseDown={(e) => e.preventDefault()}
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
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSubmit}
            disabled={!value.trim() || busy}
            aria-label="Отправить"
            className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-white" />
          </button>
        </div>
        <p className="text-[13px] text-sub mb-2 px-1">{hint}</p>
        <ErrorBanner
          error={error}
          fallback="Не удалось отправить — попробуйте ещё раз"
          variant="block"
          className="mb-2"
        />
        <ErrorBanner
          error={transcribeAudio.error}
          fallback="Не удалось распознать речь. Проверьте соединение."
          variant="block"
          className="mb-2"
        />
        <textarea
          autoFocus
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          // Та же задержка, что у поля комментария в ленте: клик по
          // микрофону не крадёт фокус (MicKeyboardBar гасит mousedown), но
          // blur всё равно приходит раньше её onClick — задержка даёт
          // клику отработать, а не гасит панель раньше времени.
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={placeholder}
          className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none resize-none mb-3"
        />
      </div>
      {focused && mic.state === "idle" && (
        <MicKeyboardBar onStart={mic.start} ariaLabel="Надиктовать ответ" />
      )}
      {(mic.state === "recording" || mic.state === "processing") && (
        <MicOverlay
          state={mic.state}
          elapsedLabel={micElapsedLabel}
          getTimeDomainData={mic.getTimeDomainData}
          onStop={mic.stop}
        />
      )}
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
        {formatRelativeTime(event.created_at)} · {formatAbsoluteTime(event.created_at)}
      </span>
    </div>
  );
}

function CommentCard({ comment }: { comment: ApiComment }) {
  // Комментарий без автора пишет сам сервер — сторож, снимающий задачу с
  // молчащего исполнителя (см. agent-state.ts, user_id = NULL). Раньше лента
  // подписывала такие «Неизвестный», как будто это чей-то потерянный
  // комментарий; владелец 27.08.2026: «когда сторож снимает задачу, надо
  // писать не неизвестный, а Система». Вместо буквенной аватарки — шестерня,
  // тем же приёмом, что уже разводит системные и людские уведомления
  // (NotificationsScreen).
  const isSystem = !comment.user_name;
  return (
    <div className="bg-card rounded-2xl p-3">
      <div className="flex items-center gap-2 mb-1">
        {isSystem ? (
          <span className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-dim shrink-0">
            <Icon name="gear" size={12} />
          </span>
        ) : (
          <Avatar
            initials={comment.user_initials || "?"}
            color={comment.user_color || "#A6A6A6"}
            avatar_url={comment.user_avatar_url}
            size={20}
          />
        )}
        <span className="text-[13px] font-medium">
          {comment.user_name || "Система"}
        </span>
        <span className="text-[11px] text-dim ml-auto">
          {formatRelativeTime(comment.created_at)} · {formatAbsoluteTime(comment.created_at)}
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
