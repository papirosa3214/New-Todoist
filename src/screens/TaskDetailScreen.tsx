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
import { useProjects } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { useUpdateSubtask, useSubtaskWork } from "../api/subtasks";
import { useAddComment } from "../api/comments";
import { ApiError } from "../api/client";
import {
  Icon,
  Avatar,
  Button,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";
import { PRIORITIES } from "../components/TaskFields";
import {
  AgentStatusRow,
  AgentOwnerActions,
  TaskFeed,
} from "../components/TaskJournal";
import { MicKeyboardBar } from "../components/MicKeyboardBar";
import { MicOverlay } from "../components/MicOverlay";
import { isTaskOwner } from "../lib/taskOwner";
import { formatDueLabel, formatTimeRange } from "../lib/date";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { combineDictatedText } from "../lib/dictationParser";
import { useUploadAttachment, useDeleteAttachment } from "../api/attachments";
import { AttachmentView } from "../components/AttachmentView";
import type { ApiAttachment } from "../api/types";
import { SubtaskFeed } from "../components/SubtaskFeed";

export function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, isError, error } = useTask(id);
  // Название и цвет проекта берём из справочника по project_id: детальный
  // ответ сервера (GET /api/tasks/:id) их не отдаёт вовсе, там только сам
  // project_id — в отличие от списка задач, где project_name/_color есть и
  // ими пользуется бейдж на доске. Тот же приём, что в TodayScreen для
  // цвета плашек в сетке часов.
  const { data: projects = [] } = useProjects();
  const { data: currentUser } = useCurrentUser();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateSubtask = useUpdateSubtask();
  const subtaskWork = useSubtaskWork();
  const addComment = useAddComment(id || "");
  const { confirm, alert, dialog } = useDialog();
  const queryClient = useQueryClient();

  const [commentText, setCommentText] = useState("");
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

  // Цвет приоритета теперь показывает флажок у заголовка, а не обводка
  // отметки (решение Максима 15.08.2026).
  const priority = PRIORITIES.find((p) => p.key === task.priority);
  const taskProject = projects.find((p) => p.id === task.project_id);
  const showPriorityFlag = !!task.priority && task.priority <= 3;
  const doneSubtasks = task.subtasks.filter((s) => s.done).length;
  const allSubtasksDone =
    task.subtasks.length > 0 && doneSubtasks === task.subtasks.length;
  // Максим 17.08.2026: «когда есть подзадачи, убирать квадратик из главной
  // задачи» — не только пока подзадачи не все закрыты (это уже было), а
  // ВООБЩЕ, пока задача активна. Отметить готовой одним тычком по квадрату
  // здесь больше нельзя, если есть хоть одна подзадача — вместо этого, когда
  // все подзадачи выполнены, ниже под списком появляется явный выбор из двух
  // кнопок (закрыть / доработать, см. ниже). Уже выполненную задачу тычком
  // возвращают в работу как и раньше — это не «закрытие», квадрат тут просто
  // индикатор состояния.
  const showHeaderCheckbox =
    task.status === "completed" || task.subtasks.length === 0;

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
        // Три точки → меню из двух пунктов убраны (Максим 18.08.2026):
        // «Изменить» и так означает то же, что «Добавить подзадачу» внизу
        // (обе ведут в форму редактирования — переименована и вынесена из-
        // под условия ниже, теперь видна всегда, не только когда все
        // подзадачи выполнены). «Удалить» — единственное действие, у
        // которого не было своего места, и оно получает прямую кнопку:
        // назад слева, корзина справа, без промежуточного меню.
        actions={
          <button
            onClick={handleDelete}
            className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
            aria-label="Удалить задачу"
          >
            <Icon name="trash" size={18} className="text-coral" />
          </button>
        }
      />

      {/* Проект — бейджем над заголовком (Максим 19.08.2026: «вверху
          небольшой бейджик ставь, в рамках какого проекта — а то цвет-то
          есть, но я его наизусть не знаю»). До этого принадлежность к
          проекту в карточке выражал только цвет, который надо помнить.
          Вид — ровно тот же бейдж, что на карточках доски (TaskBoard):
          решётка, название, заливка цветом проекта в 15%. Отступ слева
          pl-[30px] — как у описания ниже: 18px кружка приоритета плюс
          gap-3, чтобы бейдж встал по одной вертикали с текстом задачи, а
          не с отметкой. */}
      {taskProject && (
        <div className="mb-2 pl-[30px]">
          {/* Без заливки — просто решётка и цветной текст, как в строке
              списка и на карточке доски (владелец 19.08.2026: «она не
              должна иметь заливку, просто цветной текст с решёткой»). */}
          <span
            className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium"
            style={{ color: taskProject.color || "#A6A6A6" }}
          >
            <Icon name="hash" size={10} className="shrink-0" />
            <span className="truncate max-w-[220px]">{taskProject.name}</span>
          </span>
        </div>
      )}

      {/* Priority ring + Title — owner 2026-08-13: was 22px (odd one out
          against the 18px this app's other two priority dots — list rows,
          board cards — now converge on), unified down to the same 18px so
          every priority dot in the app measures the same. */}
      <div className="flex items-start gap-3 mb-4">
        {/* Квадрат и серый — как в списке и на доске (решение Максима
            15.08.2026): круг остаётся за подзадачами, цвет приоритета ушёл
            во флажок. Отметка в шапке — только для задач без подзадач
            (или уже выполненных, для возврата в работу) — см.
            showHeaderCheckbox выше. */}
        {showHeaderCheckbox ? (
          // Зона нажатия — 44×44 (норма HIG), а сам квадрат остаётся 18×18:
          // это ГЛАВНЫЙ контрол завершения задачи, и мазать по нему пальцем
          // было нечем (замер 19.08.2026: проба elementFromPoint ±22pt не
          // попадала ни по одной оси). Расширяем прозрачным ::before ровно
          // 44×44 (h-11 w-11) по центру кнопки, а НЕ паддингом с
          // отрицательным margin: паддинг раздул бы саму коробку кнопки, и
          // gap-3 отодвинул бы заголовок вправо. Размер задан явно, а не
          // через -inset: у кнопки рамка 2px, отсчёт inset идёт от
          // padding-box (14×14), и «-inset-[13px]» дало бы 40×40 — замер это
          // и показал. z-10 — потому что заголовок идёт в разметке ПОСЛЕ
          // кнопки и без него перехватывал бы правую половину зоны (проба
          // ±21.5pt вправо падала именно на h1).
          <button
            onClick={handleToggleStatus}
            className="relative z-10 mt-1 w-[18px] h-[18px] rounded-md border-2 border-dim shrink-0 flex items-center justify-center tap-scale before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
          >
            {task.status === "completed" && (
              <Icon name="check" size={12} className="text-white" />
            )}
          </button>
        ) : (
          <div className="mt-1 w-[18px] h-[18px] shrink-0" aria-hidden="true" />
        )}
        {/* leading-snug (1.375× = 27.5px) убран 20.08.2026: интерлиньяж
            крупных кеглей задаёт таблица в index.css (@layer base), у 20px
            там 23px — собственный бокс шрифта. Со snug заголовок карточки
            шёл с тем же воздухом, что основной текст 15px, хотя по §15
            крупному набору положено теснее; заодно уходила дробная высота
            строки 27.5px. Утилита в разметке перебила бы таблицу (утилиты
            лежат слоем выше), поэтому её именно снимаем, а не меняем. */}
        <h1
          className={`text-[20px] font-semibold flex-1 ${task.status === "completed" ? "line-through text-sub" : ""}`}
        >
          {task.title}
        </h1>
        {/* Флажок приоритета — справа от заголовка, там же, где в строке
            списка он стоит в метаданных. Низкий (P4) не показываем: это
            значение по умолчанию. */}
        {showPriorityFlag && (
          <Icon
            name="flag"
            size={16}
            className="mt-1 shrink-0"
            style={{ color: priority?.color }}
            aria-label={`Приоритет: ${priority?.name ?? ""}`}
          />
        )}
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

      {/* Файлы самой задачи — приложенные в форме, под «Заметкой»
          (19.08.2026). Показываются здесь, а не в ленте: это часть
          описания задачи, а не сообщение в переписке. Тем же компонентом,
          что и вложения ленты — картинка превью, документ строкой. Отступ
          слева тот же pl-[30px], что у описания выше: файл продолжает
          заметку, а не начинает новый уровень. */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="mb-4 pl-[30px]">
          {task.attachments.map((att) => (
            <AttachmentView key={att.id} attachment={att} />
          ))}
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-[2px] mb-4">
        {task.due_date && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Icon name="calendarSmall" size={18} className="text-red" />
            {/* Время — здесь же, одной строкой с датой (Максим 19.08.2026:
                «пишется только „сегодня, 19 августа“, а время видно, только
                если нажать „Изменить“»), и сразу ИНТЕРВАЛОМ: «Сегодня, 19
                авг. · 13:45—14:30». Он же, следом: «пиши прям тот период,
                который выбран, чтобы мне не нужно было высчитывать, во
                сколько я освобожусь». Отдельной длительности («· 45 мин»)
                в строке больше нет — интервал её уже задаёт, а два способа
                сказать одно и то же только удлиняют строку.
                Формулировка общая с полем «Срок и время» самой формы
                (DueDateField): одна задача не должна читаться по-разному в
                карточке и в форме. */}
            <span className="text-[14px] text-red">
              {formatDueLabel(task.due_date)}
              {task.start_time
                ? ` · ${formatTimeRange(task.start_time, task.duration_min)}`
                : ""}
            </span>
          </div>
        )}
        {/* Приоритет — не пилюля справа, а сам флажок и слово «Приоритет»
            цветом приоритета (Максим 18.08.2026, уточнение: «не заголовок —
            заголовок не трогай, здесь только флажок и слово красишь»).
            Только в этой карточке (щёлкнул на задачу) — строка списка/
            плитка доски используют свой собственный флажок-точку рядом с
            заголовком, его не трогаю, он и так уже цветной. */}
        <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
          <Icon name="flag" size={18} style={{ color: priority?.color }} />
          <span
            className="text-[14px] flex-1"
            style={{ color: priority?.color }}
          >
            Приоритет
          </span>
        </div>
        {task.assignee_id && task.assignee_name && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Avatar
              initials={task.assignee_initials || "?"}
              color={task.assignee_color || "#A6A6A6"}
              avatar_url={task.assignee_avatar_url}
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
      <AgentOwnerActions task={task} isOwner={isTaskOwner(currentUser, task)} />

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
          edit form (see the "Изменить" button below). */}
      {task.subtasks.length > 0 && (
        <>
          <SubtaskFeed
            subtasks={task.subtasks}
            isOwner={isTaskOwner(currentUser, task)}
            onToggle={(st) =>
              updateSubtask.mutateAsync({ id: st.id, done: !st.done })
            }
            // Возврат — комментарий с вложениями идёт в общую ленту задачи
            // (18.08.2026, прямая просьба: «фото, что не нравится»), не
            // только в result подзадачи — только у comments/attachments
            // есть файлы, у result всегда был просто текст. result всё
            // равно пишется тем же текстом (без файла) — то, что видно при
            // раскрытии шага без похода в общую ленту.
            onReturn={async (st, comment, attachmentIds) => {
              await addComment.mutateAsync({
                text: `По шагу «${st.title}»: ${comment}`,
                attachmentIds,
              });
              await subtaskWork.mutateAsync({
                id: st.id,
                state: null,
                result: comment,
              });
            }}
            // Ответ на блокировку — только комментарий в общую ленту, state
            // подзадачи не трогаем (агент сам её разблокирует, когда
            // сможет продолжить) — не путать с onReturn выше, у того
            // смысл другой (возврат в pending).
            onComment={async (st, comment, attachmentIds) => {
              await addComment.mutateAsync({
                text: `По шагу «${st.title}»: ${comment}`,
                attachmentIds,
              });
            }}
            onUploadFile={async (file) => {
              const res = await uploadAttachment.mutateAsync(file);
              return res.attachment;
            }}
          />
          <ErrorBanner
            error={updateSubtask.error}
            fallback="Не удалось обновить подзадачу"
            variant="block"
            className="-mt-2 mb-4"
          />
        </>
      )}

      {/* «Закрыть задачу» + «Изменить» — Максим 18.08.2026: три точки в
          шапке убраны (см. ScreenHeader выше), «Изменить» — единственный
          путь в форму редактирования, и она обязана быть видна ВСЕГДА,
          не только когда все подзадачи выполнены — раньше это была кнопка
          «Добавить подзадачу», условная на allSubtasksDone, и у активной
          задачи с недоделанными шагами (или вовсе без них) редактировать
          было бы нечем. «Закрыть задачу» остаётся условной как была:
          явный выбор вместо квадратика в шапке (showHeaderCheckbox выше,
          Максим 17.08.2026) — либо шагов хватило и задачу закрывают сразу,
          либо нет, и тогда просто идут менять. */}
      <div className="space-y-2 mb-4">
        {allSubtasksDone && task.status === "active" && (
          <Button variant="primary" onClick={handleToggleStatus}>
            <Icon name="check" size={16} />
            Закрыть задачу
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => navigate(`/task/${task.id}/edit`)}
        >
          <Icon name="edit" size={16} />
          Изменить
        </Button>
      </div>

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
            // Видимый квадрат остаётся 40×40 (иначе перекосится строка
            // ввода), а зона нажатия добирается до 44×44 нормы HIG
            // прозрачным ::before на 2pt в каждую сторону: соседнее поле
            // отстоит на gap-2 = 8pt, так что зоны не пересекаются.
            className="relative w-[40px] h-[40px] rounded-xl bg-card flex items-center justify-center shrink-0 disabled:opacity-50 tap-scale before:absolute before:-inset-[2px] before:content-['']"
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
            // Та же добивка зоны до 44×44, что у скрепки слева.
            className="relative w-[40px] h-[40px] rounded-xl bg-red flex items-center justify-center shrink-0 disabled:opacity-50 tap-scale before:absolute before:-inset-[2px] before:content-['']"
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
