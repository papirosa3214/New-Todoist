// Просмотр задачи: заголовок/описание/срок/приоритет/метки/исполнитель —
// только чтение, подзадачи — можно отмечать выполненными прямо здесь
// (как и было). Полное редактирование полей (включая CRUD подзадач)
// живёт в TaskFormScreen — карандаш в шапке ведёт туда (owner 2026-08-10:
// «точно такой же интерфейс должен открываться при редактировании» —
// переиспользуем форму создания вместо отдельного подменю).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { TaskRow } from "../components/TaskRow";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTask, useUpdateTask, useDeleteTask, useStartResearch } from "../api/tasks";
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
  Loading,
  PriorityArrows,
  ReadyFlag,
} from "../components/UI";
import { PRIORITIES } from "../components/TaskFields";
import { MarkdownInline } from "../components/MarkdownInline";
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
import { TemplateStore } from "../lib/templates";
import { AttachmentView } from "../components/AttachmentView";
import { AttemptLadderBadge } from "../components/AttemptLadderBadge";
import { CollaborationPlanPanel } from "../components/CollaborationPlanPanel";
import type { ApiAttachment } from "../api/types";
import { SubtaskFeed } from "../components/SubtaskFeed";
import {
  setManualIslandTask,
  stopTaskLiveActivity,
  syncTaskToLiveActivity,
} from "../lib/liveActivity";
import { hapticDrop } from "../lib/haptics";

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
  // У РОДИТЕЛЯ ПЕРВЫМ ПОКАЗЫВАЕМ ДЕТЕЙ, А НЕ ЧЕК-ЛИСТ (10.09.2026,
  // a195895d). Разбиение родительской задачи — это и есть дочерние
  // карточки; шаги у неё если и остались, то от прежней жизни. Открывая
  // такую карточку, владелец хочет видеть, кто и что делает, а не свой
  // старый список пунктов.
  const [activeTab, setActiveTab] = useState<"details" | "team">("details");

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
  // Карточка с детьми открывается на них: дети — её разбиение, чек-лист
  // у неё вторичен (10.09.2026, a195895d). Пересобирается по id задачи,
  // а не один раз: переход между карточками не должен оставлять вкладку
  // от предыдущей.
  useEffect(() => {
    setActiveTab(task?.children?.length ? "team" : "details");
  }, [id, task?.children?.length]);

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
      // Задачи не станет — снимаем и карточку из островка, и пометку
      // «эту вывели руками», иначе автозапуск будет считать, что владелец
      // всё ещё смотрит на удалённую задачу.
      setManualIslandTask(null);
      await stopTaskLiveActivity(task.id);
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
    if (newStatus === "completed") {
      const openSubtasks = (task.subtasks || []).filter((st) => !st.done);
      if (openSubtasks.length > 0) {
        const ok = await confirm({
          title: "Завершить задачу?",
          description:
            openSubtasks.length === 1
              ? `Шаг «${openSubtasks[0].title}» останется невыполненным, а задача уйдёт в готовые.`
              : `Осталось невыполненных шагов: ${openSubtasks.length}. Завершить задачу?`,
          confirmLabel: "Завершить",
          cancelLabel: "Отмена",
        });
        if (!ok) return;
      }
    }
    await updateTask.mutateAsync({ id: task.id, status: newStatus });
  });

  // Поднять/снять флаг готовности к самозахвату (d598de9f, миграция 026).
  // Кнопка одна: переключает текущее значение на противоположное.
  // Сервер примет PATCH только от владельца, иначе 403 — мы кнопку всё
  // равно рисуем только владельцу, но двойная защита не мешает: если кто-то
  // обошёл UI и шлёт напрямую, гейт в routes/tasks.ts его всё равно
  // остановит.
  const handleToggleReady = useGuardedCallback(async () => {
    if (!task) return;
    const next = !task.ready_for_pickup;
    await updateTask.mutateAsync({ id: task.id, ready_for_pickup: next });
  });

  // «Нужно глубокое исследование» (миграция 052). Галочка — обычное поле
  // карточки; кнопка запуска поднимает флаг, если он ещё не стоит, и дергает
  // серверный конвейер (POST /research). Сам обход идёт в фоне, отчёт
  // появляется в секции «Отчёты».
  const startResearch = useStartResearch();

  const handleToggleResearch = useGuardedCallback(async () => {
    if (!task) return;
    await updateTask.mutateAsync({
      id: task.id,
      needs_research: !task.needs_research,
    });
  });

  const handleStartResearch = useGuardedCallback(async () => {
    if (!task) return;
    if (!task.needs_research) {
      await updateTask.mutateAsync({ id: task.id, needs_research: true });
    }
    try {
      await startResearch.mutateAsync(task.id);
      alert(
        "Исследование запущено. Сервер сам соберёт источники, сверит их и положит отчёт в секцию «Отчёты» этой карточки — это занимает несколько минут.",
      );
    } catch (e) {
      alert(
        e instanceof ApiError
          ? `Не удалось запустить исследование: ${e.message}`
          : `Не удалось запустить исследование: ${String(e)}`,
      );
    }
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

  const [templateToast, setTemplateToast] = useState(false);
  // Раньше здесь был флаг: тост «выведено в Dynamic Island» загорался всегда,
  // потому что вызов не дожидались, а его ошибку глушили. Полгода функция была
  // мертва (плагин не зарегистрирован), а приложение рапортовало успехом.
  // Теперь тост несёт настоящий итог.
  const [liveActivityToast, setLiveActivityToast] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const handleSaveAsTemplate = () => {
    if (!task) return;
    TemplateStore.saveTemplate({
      title: task.title,
      description: task.description || undefined,
      priority: task.priority || 4,
      subtasks: task.subtasks?.map((st) => st.title) || [],
      category: "Пользовательские",
    });
    setTemplateToast(true);
    setTimeout(() => setTemplateToast(false), 2500);
  };

  if (isLoading) {
    return <Loading variant="block" />;
  }

  if (isError) {
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

  const priority = PRIORITIES.find((p) => p.key === task.priority);
  const taskProject = projects.find((p) => p.id === task.project_id);
  // Квадратик завершения убран из шапки карточки (Максим, 24.08.2026) — тем
  // же решением, что раньше вычистило чекбоксы из списка и с доски: задачу он
  // закрывает кнопками внизу, а квадратик только съедал место слева и тянул
  // заголовок вправо. handleToggleStatus остаётся: им пользуются кнопки.

  return (
    <div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))]">
      {dialog}
      {templateToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-stroke rounded-xl px-4 py-2.5 shadow-xl flex items-center gap-2 text-sm text-text">
          <Icon name="check" size={16} className="text-sub" />
          <span>Задача сохранена в шаблоны</span>
        </div>
      )}
      {liveActivityToast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-card border rounded-xl px-4 py-2.5 shadow-xl flex items-center gap-2 text-sm max-w-[calc(100vw-2rem)] ${
            liveActivityToast.ok
              ? "border-blue-500/40 text-blue-400"
              : "border-red-500/40 text-red-400"
          }`}
        >
          <Icon name={liveActivityToast.ok ? "activity" : "info"} size={16} />
          <span>{liveActivityToast.text}</span>
        </div>
      )}
      <ScreenHeader
        variant="compact"
        title=""
        actions={
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                if (!task) return;
                hapticDrop();
                // force: кнопка выводит в островок любую задачу, даже когда
                // работа по ней ещё не идёт. Сам собой он загорается только
                // на задачах в работе — см. syncTaskToLiveActivity.
                // Карточек теперь до трёх, и эта не вытесняет работу агентов,
                // а встаёт в тройку первой: раскладку пересобирает
                // useLiveActivitySync, он же погасит лишнее сверх трёх.
                setManualIslandTask(task.id);
                const res = await syncTaskToLiveActivity(task, { force: true });
                setLiveActivityToast(
                  res.ok
                    ? { ok: true, text: "Задача выведена в Dynamic Island" }
                    : { ok: false, text: res.reason },
                );
                setTimeout(() => setLiveActivityToast(null), 3000);
              }}
              className="tap-scale w-[40px] h-[44px] flex items-center justify-center text-dim active:text-blue"
              aria-label="Вывести в Dynamic Island"
              title="Вывести в Dynamic Island"
            >
              <Icon name="activity" size={18} />
            </button>
            <button
              onClick={handleSaveAsTemplate}
              className="tap-scale w-[40px] h-[44px] flex items-center justify-center text-dim active:text-amber-400"
              aria-label="Сохранить как шаблон"
              title="Сохранить как шаблон"
            >
              <Icon name="bookmark" size={18} />
            </button>
            <button
              onClick={handleDelete}
              className="tap-scale w-[40px] h-[44px] flex items-center justify-center"
              aria-label="Удалить задачу"
            >
              <Icon name="trash" size={18} className="text-coral" />
            </button>
          </div>
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
      {/* Номер карточки — тот самый короткий идентификатор, которым агенты
          оперируют в чате («карточка bb728617»). Владелец 11.09.2026: «я-то
          их не вижу, поэтому понятия не имею, о какой карточке ты говоришь».
          Поэтому сносочка в самом начале и намеренно невыразительная:
          caption + text-dim — подпись, которую можно не читать. */}
      <div className="text-[11px] text-dim mb-1">{task.id.slice(0, 8)}</div>

      {taskProject && (
        <div className="mb-2">
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

      {/* Priority ring + Title */}
      <div className="flex items-start gap-3 mb-4">
        <h1
          className={`text-[20px] font-semibold flex-1 ${task.status === "completed" ? "line-through text-sub" : ""}`}
        >
          <MarkdownInline source={task.title} />
        </h1>
        {/* Справа от заголовка — ПОДНЯТЫЙ ФЛАГ ГОТОВНОСТИ, а не приоритет.
            До 11.09.2026 здесь стоял флажок приоритета, и он же сбил
            владельца с толку: «точно знаю, что была задача, где флаг
            поднят, но где он в карточке высвечивался — не увидел». Пока
            флажок означал две разные вещи, отличить их было нельзя.
            Приоритет теперь читается шевронами в строке ниже. */}
        {task.ready_for_pickup ? (
          <span className="mt-1 shrink-0">
            <ReadyFlag size={16} />
          </span>
        ) : null}
      </div>

      <ErrorBanner
        error={updateTask.error}
        fallback="Не удалось обновить задачу"
        variant="block"
        className="mb-4"
      />

      {/* Description — БЕЗ pl-[30px]: владелец 22.08.2026 хочет текст
          вплотную по ширине экрана («выровнен по ширине мобильного
          экрана, сейчас есть небольшой отступ»). Раньше отступ держал
          описание под заголовком с кольцом, но это лишний воздух на
          телефоне. */}
      {task.description && (
        <p className="text-[14px] text-sub leading-relaxed mb-4 whitespace-pre-wrap">
          {task.description}
        </p>
      )}

      {/* Файлы самой задачи — приложенные в форме, под «Заметкой»
          (19.08.2026). Показываются здесь, а не в ленте: это часть
          описания задачи, а не сообщение в переписке. Тем же компонентом,
          что и вложения ленты. Отступ слева убран вместе с описанием:
          файл продолжает заметку вплотную к краю экрана. */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="mb-4">
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
          {/* С 11.09.2026 приоритет — шевроны, а не флажок: флажок
              теперь занят под поднятый флаг готовности. */}
          <PriorityArrows priority={task.priority} size={13} />
          <span
            className="text-[14px] flex-1"
            style={{ color: priority?.color }}
          >
            Приоритет
          </span>
        </div>
        {/* Поднятый флаг готовности — отдельной строкой рядом с приоритетом.
            Владелец 11.09.2026: «точно знаю, что была задача, где флаг
            поднят, но где он в карточке высвечивался — не увидел». Кнопка
            управления флагом живёт ниже, среди владельческих действий, но
            СОСТОЯНИЕ должно читаться сразу, а не выводиться из подписи
            кнопки. Строки нет — значит флаг не поднят. */}
        {task.ready_for_pickup ? (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <ReadyFlag size={16} />
            <span className="text-[14px] flex-1 text-green">
              Флаг поднят — можно брать в работу
            </span>
          </div>
        ) : null}
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
        <AttemptLadderBadge task={task} />
        <CollaborationPlanPanel taskId={task.id} />
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

      {/* Tabs navigation — only needed if BOTH subtasks and child tasks exist */}
      {task.subtasks.length > 0 &&
        task.children &&
        task.children.length > 0 && (
          <div className="flex gap-4 border-b border-sub/20 mb-4 px-1">
            <button
              className={`pb-2 text-[14px] font-medium transition-colors border-b-2 ${
                activeTab === "details"
                  ? "border-red text-text"
                  : "border-transparent text-sub hover:text-text"
              }`}
              onClick={() => setActiveTab("details")}
            >
              Чек-лист ({task.subtasks.length})
            </button>
            <button
              className={`pb-2 text-[14px] font-medium transition-colors border-b-2 ${
                activeTab === "team"
                  ? "border-red text-text"
                  : "border-transparent text-sub hover:text-text"
              }`}
              onClick={() => setActiveTab("team")}
            >
              Команда ({task.children.length})
            </button>
          </div>
        )}

      {/* Subtasks checklist */}
      {task.subtasks.length > 0 &&
        (!task.children?.length || activeTab === "details") && (
          <>
            <SubtaskFeed
              subtasks={task.subtasks}
              isOwner={isTaskOwner(currentUser, task)}
              onToggle={(st) =>
                updateSubtask.mutateAsync({ id: st.id, done: !st.done })
              }
              onReturn={async (st, comment, attachmentIds) => {
                await subtaskWork.mutateAsync({
                  id: st.id,
                  state: null,
                  result: comment,
                });
                await addComment.mutateAsync({
                  text: `По шагу «${st.title}»: ${comment}`,
                  attachmentIds,
                });
              }}
              onComment={async (st, comment, attachmentIds) => {
                await subtaskWork.mutateAsync({ id: st.id, state: null });
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
              error={
                updateSubtask.error || addComment.error || subtaskWork.error
              }
              fallback="Не удалось обновить подзадачу"
              variant="block"
              className="-mt-2 mb-4"
            />
          </>
        )}

      {/* Children tasks / Delegated tasks */}
      {task.children &&
        task.children.length > 0 &&
        (!task.subtasks.length || activeTab === "team") && (
          <div className="mb-4 space-y-1">
            <div className="text-[11px] text-sub font-medium px-1 mb-2">
              Дочерние задачи ({task.children.length})
            </div>
            {task.children.map((child: any) => (
              <TaskRow
                key={child.id}
                task={child}
                onClick={() => navigate(`/task/${child.id}`)}
              />
            ))}
          </div>
        )}

      {/* «Изменить» — единственный путь в форму редактирования, поэтому
          видна ВСЕГДА: там же правят, добавляют и переставляют шаги.
          ⚠️ Кнопки «Закрыть задачу» здесь БОЛЬШЕ НЕТ (отменено 21.08.2026,
          Максим: «вот эта закрыть задачу надо убрать, её вообще здесь не
          должно существовать»). Раньше она появлялась под списком, когда
          все шаги выполнены, и закрывала задачу мимо приёмки. Теперь
          закрытие идёт только через «Принять» на сданной задаче
          (TaskJournal.tsx) — итог сперва показывают владельцу, а не
          отправляют карточку с доски одним нажатием. */}
      {/* Кнопки действий: если задача активна и не находится на проверке у агента,
          владелец может завершить задачу (или открыть заново, если она закрыта). */}
      <div className="space-y-2 mb-4">
        {task.status === "active" && !task.agent_state && (
          <Button variant="primary" onClick={handleToggleStatus}>
            <Icon name="check" size={16} />
            Завершить задачу
          </Button>
        )}
        {task.status === "completed" && (
          <Button variant="secondary" onClick={handleToggleStatus}>
            <Icon name="refresh" size={16} />
            Открыть задачу заново
          </Button>
        )}

        {/* ГОТОВНОСТЬ К САМОЗАХВАТУ (d598de9f, миграция 026). Кнопку
            видит только владелец; не-владельцу — бейдж с состоянием,
            чтобы было ясно, можно ли задачу брать. При выключенной службе
            (showReadyFlags === false) скрываем — флаг тогда ничего не делает. */}
        {isTaskOwner(currentUser, task) ? (
          <Button
            variant={task.ready_for_pickup ? "secondary" : "primary"}
            onClick={handleToggleReady}
          >
            <Icon name={task.ready_for_pickup ? "check" : "flag"} size={16} />
            {task.ready_for_pickup
              ? "Снять флаг готовности"
              : "Готово к работе"}
          </Button>
        ) : (
          <div className="text-[13px] text-sub">
            {task.ready_for_pickup
              ? "Готова к самозахвату"
              : "Ждёт подтверждения владельца"}
          </div>
        )}

        {/* ГЛУБОКОЕ ИССЛЕДОВАНИЕ (миграция 052). Тумблер-галочка — обычное
            поле карточки, кнопка запуска — только когда флаг поднят. Конвейер
            серверный, поэтому владелец видит его в «Отчётах», а не в ленте
            агента. */}
        {isTaskOwner(currentUser, task) && (
          <Button
            variant={task.needs_research ? "secondary" : "outline"}
            onClick={handleToggleResearch}
          >
            <Icon name="search" size={16} />
            {task.needs_research
              ? "Глубокое исследование: включено"
              : "Нужно глубокое исследование"}
          </Button>
        )}
        {isTaskOwner(currentUser, task) && task.needs_research && (
          <Button
            variant="primary"
            onClick={handleStartResearch}
            disabled={startResearch.isPending}
          >
            <Icon name="sparkles" size={16} />
            {startResearch.isPending
              ? "Запускаю…"
              : "Запустить исследование"}
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
          потоке (AGENT-PROTOCOL.md, "Журнал задачи"): поле ввода
          комментариев перенесено в начало секции перед списком записей,
          чтобы можно было оставлять комментарии без прокрутки всей ленты. */}
      <div>
        <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">Лента</h3>
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
          className="flex items-center gap-2 mb-3"
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
            // добиваем явным скроллом.
            onFocus={() => {
              setCommentFocused(true);
              commentInputRef.current?.scrollIntoView({ block: "nearest" });
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
            // Тап при открытой клавиатуре сначала уводит фокус с поля,
            // клавиатура съезжает, строка ввода переезжает вниз — и кнопка
            // уходит из-под пальца между touchstart и touchend, click не
            // приходит вовсе. Гасим mousedown, фокус остаётся в поле. Тот же
            // приём, что в MicKeyboardBar и ReplyForm (SubtaskFeed.tsx).
            onMouseDown={(e) => e.preventDefault()}
            disabled={
              (!commentText.trim() && pending.length === 0) ||
              addComment.isPending
            }
            // Та же добивка зоны до 44×44, что у скрепки слева.
            className="relative w-[40px] h-[40px] rounded-xl bg-red flex items-center justify-center shrink-0 disabled:opacity-50 disabled:cursor-not-allowed tap-scale before:absolute before:-inset-[2px] before:content-['']"
          >
            <Icon name="chevron" size={16} className="text-white -rotate-90" />
          </button>
        </form>
        <TaskFeed task={task} />
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
