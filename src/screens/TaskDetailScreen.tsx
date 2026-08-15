// Просмотр задачи: заголовок/описание/срок/приоритет/метки/исполнитель —
// только чтение, подзадачи — можно отмечать выполненными прямо здесь
// (как и было). Полное редактирование полей (включая CRUD подзадач)
// живёт в TaskFormScreen — карандаш в шапке ведёт туда (owner 2026-08-10:
// «точно такой же интерфейс должен открываться при редактировании» —
// переиспользуем форму создания вместо отдельного подменю).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTask, useUpdateTask, useDeleteTask } from "../api/tasks";
import { useCurrentUser } from "../api/auth";
import { useUpdateSubtask } from "../api/subtasks";
import { useAddComment } from "../api/comments";
import { ApiError } from "../api/client";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";
import { PRIORITIES, PriorityPill } from "../components/TaskFields";
import {
  AgentStatusRow,
  AgentOwnerActions,
  TaskFeed,
} from "../components/TaskJournal";
import { ActionsMenu } from "../components/ActionsMenu";
import { MicKeyboardBar } from "../components/MicKeyboardBar";
import { MicOverlay } from "../components/MicOverlay";
import { formatDueLabel } from "../lib/date";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { combineDictatedText } from "../lib/dictationParser";
import { useUploadAttachment, useDeleteAttachment } from "../api/attachments";
import type { ApiAttachment } from "../api/types";
import { SubtaskFeed } from "../components/SubtaskFeed";

export function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, isError, error } = useTask(id);
  const { data: currentUser } = useCurrentUser();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateSubtask = useUpdateSubtask();
  const addComment = useAddComment(id || "");
  const { confirm, alert, dialog } = useDialog();
  const queryClient = useQueryClient();

  const [commentText, setCommentText] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsAnchorRef = useRef<HTMLButtonElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Файлы грузятся сразу при выборе, а не в момент отправки: так человек
  // видит, что вложение принято (и может его убрать), ещё пока пишет текст.
  // До отправки комментария они висят «ничьими» и подбираются им же.
  const uploadAttachment = useUploadAttachment(id || "");
  const deleteAttachment = useDeleteAttachment();
  const [pending, setPending] = useState<ApiAttachment[]>([]);

  // Микрофон в ленте — та же плавающая кнопка над клавиатурой, что и в
  // форме задачи (MicKeyboardBar), а не отдельный значок внутри поля:
  // владелец 2026-08-14 прямо просил не городить микрофон в самой плашке.
  // Показывается, пока курсор в поле комментария.
  const [commentFocused, setCommentFocused] = useState(false);
  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text } = await transcribeAudio.mutateAsync(blob);
      // Комментарий — произвольный текст: маркеры #Проект/!приоритет тут не
      // разбираются, они формат заголовка задачи, а не ленты.
      setCommentText((prev) => combineDictatedText(prev, text));
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

  // "Аренда истекла" (agent_stale) is computed server-side on every read —
  // nothing pushes it to an open tab (heartbeat deliberately fires no WS
  // event, see server/src/routes/agent-state.ts). Without this, a card left
  // open through a 15-minute silent lease would keep showing "Агент
  // работает" forever — exactly the "молчание неотличимо от работы"
  // failure the whole protocol exists to prevent (AGENT-PROTOCOL.md). Only
  // polls while an agent actually holds the task, and at a cadence well
  // under the 15-minute lease so the header can catch the in_progress →
  // "агент пропал" flip (and keep "N мин назад" honest) without a reload.
  // Опрос идёт, только пока агент реально работает и ещё не просрочил
  // аренду. Как только он помечен пропавшим, опрашивать нечего: сам по
  // себе статус уже не изменится, а возвращение агента прилетит событием
  // по сокету (api/ws.ts инвалидирует кэш задач на любое task:updated) —
  // и опрос возобновится сам, потому что agent_stale снова станет false.
  // Просьба Максима 14.08.2026: «показал, что не работает — больше не
  // дёргает систему; вернулся — возобновился».
  useEffect(() => {
    if (!id || !task?.agent_state) return;
    if (task.agent_state === "in_progress" && task.agent_stale) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["tasks", id] });
    }, 30_000);
    return () => clearInterval(timer);
    // agent_stale в зависимостях обязателен: без него эффект не
    // пересобрался бы в момент, когда агент вернулся, и опрос не
    // возобновился бы.
  }, [id, task?.agent_state, task?.agent_stale, queryClient]);

  // These guarded handlers close over `task`, which is only defined once
  // the query resolves — but the hooks themselves must run unconditionally,
  // above the isLoading/isError/!task early returns below. Calling a hook
  // only in the "task loaded" branch would change the hook count between
  // renders the moment the task resolves (React: "Rendered more hooks than
  // during the previous render"). Each body starts with `if (!task) return`
  // so there's nothing to actually do before the task exists — the guard
  // just can't be skipped structurally.
  const handleDelete = useGuardedCallback(async () => {
    if (!task) return;
    const ok = await confirm({
      title: "Удалить задачу без возможности отмены?",
      confirmLabel: "Удалить",
      cancelLabel: "Отмена",
      danger: true,
    });
    if (!ok) return;
    try {
      // Only the creator may delete (server enforces this with a 404, same
      // as "not found", so an assignee-only task shows this rather than a
      // 403).
      await deleteTask.mutateAsync(task.id);
      navigate(-1);
    } catch {
      await alert(
        "Не удалось удалить задачу — возможно, вы не создатель этой задачи.",
      );
    }
  });

  const handleToggleStatus = useGuardedCallback(async () => {
    if (!task) return;
    const newStatus = task.status === "active" ? "completed" : "active";
    await updateTask.mutateAsync({ id: task.id, status: newStatus });
  });

  const handleSubmitComment = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = commentText.trim();
    // Комментарий из одних файлов — нормальный случай: «вот скриншот» без
    // подписи. Пустым считается только тот, где нет ни текста, ни вложений.
    if (!trimmed && pending.length === 0) return;
    await addComment.mutateAsync({
      text: trimmed,
      attachmentIds: pending.map((a) => a.id),
    });
    setCommentText("");
    setPending([]);
  });

  const handlePickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        const res = await uploadAttachment.mutateAsync(file);
        setPending((prev) => [...prev, res.attachment]);
      } catch {
        // Причину покажет ErrorBanner ниже (uploadAttachment.error): файл
        // мог не пройти по размеру или типу — это ответ сервера, а не сбой.
        break;
      }
    }
    // Сброс значения — иначе повторный выбор того же файла не даст события.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRemovePending = async (attId: string) => {
    try {
      await deleteAttachment.mutateAsync(attId);
    } catch {
      // Даже если на сервере не удалилось — из списка убираем: иначе файл
      // прилипнет к комментарию, которого человек уже не хочет.
    }
    setPending((prev) => prev.filter((a) => a.id !== attId));
  };

  if (isLoading) {
    return <div className="px-4 py-8 text-center text-sub">Загрузка…</div>;
  }

  if (isError) {
    // A 404 (deleted task, stale link, someone else's task) is the common
    // case here and isn't a connectivity problem — showing "проверьте
    // соединение" for it would be misleading. useTask has retry: false, so
    // any non-404 failure (offline, 5xx) falls through to the ErrorBanner
    // below, which turns a raw ApiError/TypeError into real Russian copy.
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
      );
    }
    return (
      <div className="px-4 py-8">
        <ErrorBanner
          error={error}
          fallback="Не удалось загрузить задачу — проверьте соединение"
          variant="block"
        />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
    );
  }

  const priorityColor =
    PRIORITIES.find((p) => p.key === task.priority)?.color ?? "#A6A6A6";

  return (
    // pb-4 (16px) — исходный отступ снизу для «десктопной» рамки/Android,
    // где 100dvh сам ужимается под клавиатуру (см. index.html:38,
    // interactive-widget=resizes-content). На WebKit (Safari, режим «с
    // домашнего экрана») этого не происходит — 16px тонет под клавиатурой
    // высотой 280-340px, поэтому здесь добавлен --kb-inset
    // (useVisualViewportInset.ts): пока клавиатура закрыта, переменная
    // 0px и calc() равен ровно pb-4, как и было; открыта — отступ растёт
    // на её высоту.
    <div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))]">
      {dialog}
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate(-1)} />}
        title=""
        actions={
          <>
            <button
              ref={actionsAnchorRef}
              onClick={() => setActionsOpen((v) => !v)}
              className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
              aria-label="Действия с задачей"
            >
              <Icon name="dots" size={18} />
            </button>
            <ActionsMenu
              open={actionsOpen}
              onClose={() => setActionsOpen(false)}
              anchorRef={actionsAnchorRef}
              items={[
                {
                  icon: "edit",
                  label: "Изменить",
                  onClick: () => navigate(`/task/${task.id}/edit`),
                },
                {
                  icon: "trash",
                  label: "Удалить",
                  destructive: true,
                  onClick: handleDelete,
                },
              ]}
            />
          </>
        }
      />

      {/* Priority ring + Title — owner 2026-08-13: was 22px (odd one out
          against the 18px this app's other two priority dots — list rows,
          board cards — now converge on), unified down to the same 18px so
          every priority dot in the app measures the same. */}
      <div className="flex items-start gap-3 mb-4">
        <button
          onClick={handleToggleStatus}
          className="mt-1 w-[18px] h-[18px] rounded-full border-2 shrink-0 flex items-center justify-center"
          style={{ borderColor: priorityColor }}
        >
          {task.status === "completed" && (
            <Icon name="check" size={12} className="text-white" />
          )}
        </button>
        <h1
          className={`text-[20px] font-semibold leading-snug ${task.status === "completed" ? "line-through text-sub" : ""}`}
        >
          {task.title}
        </h1>
      </div>

      <ErrorBanner
        error={updateTask.error}
        fallback="Не удалось обновить задачу"
        variant="block"
        className="mb-4"
      />

      {/* Description — pl-[30px] = 18px ring + gap-3 (12px), keeps this
          aligned under the title now that the ring shrank from 22px (was
          pl-[34px] = 22+12 — recomputed here, same mismatch TaskBoard's
          footer padding had after its own dot resize). */}
      {task.description && (
        <p className="text-[14px] text-sub leading-relaxed mb-4 pl-[30px] whitespace-pre-wrap">
          {task.description}
        </p>
      )}

      {/* Metadata */}
      <div className="space-y-[2px] mb-4">
        {task.due_date && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Icon name="calendarSmall" size={18} className="text-red" />
            <span className="text-[14px] text-red">
              {formatDueLabel(task.due_date)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
          <Icon name="flag" size={18} className="text-sub" />
          <span className="text-[14px] text-sub flex-1">Приоритет</span>
          <PriorityPill priority={task.priority} />
        </div>
        {task.assignee_id && task.assignee_name && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Avatar
              initials={task.assignee_initials || "?"}
              color={task.assignee_color || "#A6A6A6"}
              size={24}
            />
            <span className="text-[14px] text-text">{task.assignee_name}</span>
          </div>
        )}
        <AgentStatusRow task={task} />
      </div>

      {/* Owner actions — agent-work protocol (AGENT-PROTOCOL.md): visible
          only to the task's creator, only while an agent_state makes them
          relevant. Renders nothing otherwise. */}
      <AgentOwnerActions
        task={task}
        isOwner={!!currentUser && currentUser.id === task.creator_id}
      />

      {/* Labels */}
      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]"
              style={{ backgroundColor: l.color + "26", color: l.color }}
            >
              <Icon name="tag" size={11} /> {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Subtasks — quick toggle only; add/rename/delete happens in the
          edit form (see header pencil button). */}
      {task.subtasks.length > 0 && (
        <>
          <SubtaskFeed
            subtasks={task.subtasks}
            onToggle={(st) =>
              updateSubtask.mutateAsync({ id: st.id, done: !st.done })
            }
          />
          <ErrorBanner
            error={updateSubtask.error}
            fallback="Не удалось обновить подзадачу"
            variant="block"
            className="-mt-2 mb-4"
          />
        </>
      )}

      {/* Лента — комментарии и журнал задачи в одном хронологическом
          потоке (AGENT-PROTOCOL.md, "Журнал задачи"): комментарии
          полноценными карточками, системные записи — приглушённой
          компактной строкой, чтобы живой текст не тонул среди служебных
          отметок. См. src/components/TaskJournal.tsx. */}
      <div>
        <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">Лента</h3>
        <TaskFeed task={task} />
        <ErrorBanner
          error={addComment.error}
          fallback="Не удалось отправить комментарий"
          variant="block"
          className="mb-2"
        />
        {/* Уже загруженные, но ещё не отправленные файлы — строкой над
            полем: видно, что вложение принято, и можно передумать до
            отправки. Крестик удаляет файл и с диска. */}
        {pending.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {pending.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-2 px-3 h-11 rounded-xl bg-card"
              >
                <Icon
                  name="paperclip"
                  size={14}
                  className="text-sub shrink-0"
                />
                <span className="flex-1 min-w-0 truncate text-[13px] text-text">
                  {att.file_name}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemovePending(att.id)}
                  aria-label="Убрать файл"
                  className="w-9 h-9 -mr-2 flex items-center justify-center text-dim"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <ErrorBanner
          error={uploadAttachment.error}
          fallback="Не удалось приложить файл"
          variant="block"
          className="mb-2"
        />
        <form
          onSubmit={handleSubmitComment}
          className="flex items-center gap-2"
        >
          {/* Скрепка слева от поля — размер тот же 40×40, что у кнопки
              отправки справа, чтобы строка ввода не перекосилась. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/plain,.doc,.docx,.odt,.ods,.xlsx"
            onChange={(e) => handlePickFiles(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadAttachment.isPending}
            aria-label="Приложить файл"
            className="w-[40px] h-[40px] rounded-xl bg-card flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <Icon name="paperclip" size={18} className="text-sub" />
          </button>
          <input
            ref={commentInputRef}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            // Родное поведение WebKit «сам подскроллит фокусный инпут над
            // клавиатурой» на iPhone ненадёжно (аудит 2026-08-11: токен
            // interactive-widget=resizes-content, на который это
            // поведение обычно опирается, в WebKit не реализован — см.
            // useVisualViewportInset.ts) — не полагаемся только на него,
            // добиваем явным скроллом. block:"end" — это поле последнее
            // в ленте, его естественное место при открытой клавиатуре —
            // у самого низа видимой области. На десктопе (клавиатуры нет)
            // это не более чем обычный скролл контейнера к уже почти
            // видимому полю — если оно и так внизу, scrollIntoView
            // фактически не двигает содержимое (проверено скриншотами,
            // см. отчёт).
            onFocus={() => {
              setCommentFocused(true);
              commentInputRef.current?.scrollIntoView({ block: "end" });
            }}
            // Кнопка микрофона живёт в портале над клавиатурой и фокус не
            // крадёт (MicKeyboardBar гасит mousedown), но blur всё равно
            // приходит раньше её onClick при переходе к другим элементам —
            // отсюда задержка: она даёт клику отработать, а не гасит панель
            // ровно в момент нажатия.
            onBlur={() => setTimeout(() => setCommentFocused(false), 150)}
            placeholder="Написать комментарий…"
            className="flex-1 bg-card rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none"
          />
          <button
            type="submit"
            disabled={
              (!commentText.trim() && pending.length === 0) ||
              addComment.isPending
            }
            className="w-[40px] h-[40px] rounded-xl bg-red flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <Icon name="chevron" size={16} className="text-white -rotate-90" />
          </button>
        </form>
      </div>
      {/* Микрофон — та же плавающая кнопка над клавиатурой, что в форме
          задачи. Появляется, пока курсор в поле комментария; надиктованный
          текст дописывается к уже набранному, а не затирает его. */}
      {commentFocused && mic.state === "idle" && (
        <MicKeyboardBar
          onStart={mic.start}
          ariaLabel="Надиктовать комментарий"
        />
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
