// Единая форма задачи — создание И редактирование одним и тем же экраном
// (owner 2026-08-10: «точно такой же интерфейс должен открываться при
// редактировании, а сейчас ничего такого не открывается» — переиспользуем
// форму, а не изобретаем отдельное подменю). Разница только в источнике
// исходных значений (пусто vs. загруженная задача) и в способе сохранения
// (POST один раз vs. PATCH одним пакетом по кнопке «Готово»). Подзадачи —
// исключение: у существующей задачи они уже персистентны, поэтому их
// CRUD идёт через живой API сразу, а не копится в локальном стейте.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useProjects } from "../api/projects";
import { useLabels } from "../api/labels";
import { useAgents } from "../api/agents";
import { useCurrentUser } from "../api/auth";
import {
  useCreateTask,
  useExtendRepeat,
  useTask,
  useUpdateTask,
} from "../api/tasks";
import {
  useCreateSubtask,
  useDeleteSubtask,
  useUpdateSubtask,
} from "../api/subtasks";
import { useStructureTaskWithAI } from "../api/ai";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  Loading,
} from "../components/UI";
import {
  Card,
  FieldRow,
  DueDateField,
  PriorityField,
  LabelsField,
  SubtaskRow,
  AddSubtaskRow,
} from "../components/TaskFields";
import { AttachmentsField } from "../components/AttachmentsField";
import { AiBusyPill } from "../components/AiBusyPill";
import { uploadAttachment } from "../api/attachments";
import { useDialog } from "../components/Dialog";
import { MicOverlay } from "../components/MicOverlay";
import { MicKeyboardBar } from "../components/MicKeyboardBar";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { hapticCross, hapticDrop, hapticGrab } from "../lib/haptics";
import {
  combineDictatedText,
  findProjectByName,
  capitalizeFirst,
  parseDictation,
} from "../lib/dictationParser";
import { todayStr } from "../lib/date";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import type { UpdateTaskInput } from "../api/tasks";
import { isTrackerOwner, roleLabel } from "../lib/taskOwner";

// Тот же приём, что SortableBoardCard у TaskBoard.tsx: dnd-kit даёт
// transform/transition/listeners — и с 26.08.2026 слушатели идут на ВСЮ
// строку (грип-точки убраны, Максим: «зажал и подтащил»). Тап-против-драга
// разводят сенсоры (TouchSensor delay 200мс / MouseSensor distance 4px,
// см. subtaskSensors ниже), а поля ввода/кнопки внутри строки глушат
// старт драга сами — см. SubtaskRow.
function SortableSubtaskRow({
  id,
  title,
  done,
  onRename,
  onDelete,
}: {
  id: string;
  title: string;
  done: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    // scale — в inline-transform (класс drag-lift был бы перебит
    // sortable-translate'ом): «подъём» строки при захвате, как на доске.
    transform: isDragging
      ? `${CSS.Transform.toString(transform) ?? ""} scale(1.04)`
      : CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "drag-lift relative z-10 rounded-xl bg-card" : ""}
    >
      <SubtaskRow
        title={title}
        done={done}
        onRename={onRename}
        onDelete={onDelete}
        dragListeners={listeners}
        dragAttributes={attributes}
        isDragging={isDragging}
      />
    </div>
  );
}

export function TaskFormScreen() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();

  const { data: agents = [], isError: agentsError } = useAgents();
  const { data: currentUser } = useCurrentUser();
  // Владелец — тоже исполнитель: карточка на нём неприкосновенна для
  // агентов. В /api/agents его нет, поэтому добавляем себя первым.
  const assigneeOptions =
    currentUser && !agents.some((a) => a.id === currentUser.id)
      ? [currentUser, ...agents]
      : agents;
  const { data: projects = [], isError: projectsError } = useProjects();
  const { data: labels = [], isError: labelsError } = useLabels();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const extendRepeat = useExtendRepeat();
  const isOwner = isTrackerOwner(currentUser);
  const {
    data: existingTask,
    isLoading: taskLoading,
    isError: taskError,
  } = useTask(id);
  const createSubtask = useCreateSubtask(id || "");
  const updateSubtask = useUpdateSubtask();
  const deleteSubtask = useDeleteSubtask();
  const structureTaskWithAI = useStructureTaskWithAI();
  const [isStructuring, setIsStructuring] = useState(false);

  const { alert, dialog } = useDialog();

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  // Файлы, выбранные ДО того, как задача создана (19.08.2026): грузить их
  // некуда — идентификатора ещё нет, — поэтому они ждут здесь и уходят на
  // сервер сразу после создания, в handleSave. В режиме правки список не
  // используется вовсе: там taskId есть, и AttachmentsField грузит файл
  // сразу при выборе.
  const [newFiles, setNewFiles] = useState<File[]>([]);
  // Авто-рост поля названия по содержимому — Максим 17.08.2026: после
  // диктовки в фиксированной 1 строке не видно, весь ли текст попал и нет
  // ли ошибок («просто так я даже не понимаю, дописалось оно или нет»).
  // rows={1} остаётся как высота ДО первого эффекта (пустое поле при
  // монтировании) — сам рост считается здесь, не CSS: у textarea нет
  // чистого CSS-способа расти по контенту без второго, зеркального
  // элемента, а он для одного поля избыточен.
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto"; // сброс перед пересчётом — иначе scrollHeight никогда не уменьшится обратно при удалении текста
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  // То же самое для описания (Максим 18.08.2026 — тот же симптом, что у
  // названия 17.08.2026, просто в другом поле: фиксированные rows={2} без
  // роста — длинный надиктованный текст прячется под внутренним скроллом
  // textarea, выглядит как «часть текста пропала», хотя она просто не
  // видна без прокрутки внутри мелкого окошка.
  const descRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [desc]);
  const [assignee, setAssignee] = useState<string | undefined>();
  const [priority, setPriority] = useState(1);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  // Create mode only — subtasks of a not-yet-created task have no id to
  // CRUD against, so they're held locally and sent as part of the atomic
  // POST /api/tasks `subtasks` param (see handleSave).
  const [localSubtasks, setLocalSubtasks] = useState<string[]>([]);

  // Порядок подзадач (edit-mode) — тот же приём, что colItems у TaskBoard.
  // Держим локально id-список, а не читаем existingTask.subtasks напрямую в
  // рендере: во время самого драга и пока PATCH'и ещё в полёте, сервер
  // (через WS-broadcast) может прислать старый порядок и на миг откатить
  // визуально то, что человек только что расставил.
  const [subtaskOrder, setSubtaskOrder] = useState<string[]>([]);
  const [draggingSubtask, setDraggingSubtask] = useState(false);
  const persistingSubtaskOrder = useRef(false);
  useEffect(() => {
    if (draggingSubtask || persistingSubtaskOrder.current) return;
    setSubtaskOrder((existingTask?.subtasks || []).map((s) => s.id));
  }, [existingTask?.subtasks, draggingSubtask]);

  // Над какой подзадачей палец висел на прошлом событии — виброотклик
  // должен приходиться на пересечение границы строки, не на каждый кадр.
  const lastSubtaskOverRef = useRef<string | null>(null);
  // Тащат всю строку подзадачи (грип убран, 26.08.2026): мышь — от 4px,
  // палец — удержание 200мс; тап по названию по-прежнему открывает
  // переименование, движение сразу — скролл формы.
  const subtaskSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleSubtaskDragEnd(event: DragEndEvent) {
    setDraggingSubtask(false);
    lastSubtaskOverRef.current = null;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = subtaskOrder.indexOf(String(active.id));
    const newIndex = subtaskOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(subtaskOrder, oldIndex, newIndex);
    hapticDrop();
    setSubtaskOrder(reordered);
    persistingSubtaskOrder.current = true;
    try {
      const byId = new Map(
        (existingTask?.subtasks || []).map((s) => [s.id, s]),
      );
      const patches = reordered
        .map((subtaskId, index) => ({ subtaskId, index }))
        .filter(
          ({ subtaskId, index }) => byId.get(subtaskId)?.position !== index,
        )
        .map(({ subtaskId, index }) =>
          updateSubtask.mutateAsync({ id: subtaskId, position: index }),
        );
      if (patches.length > 0) await Promise.all(patches);
    } catch (err) {
      // Тот же приём, что у TaskBoard.handleDragEnd: если часть PATCH-ей не
      // прошла, локальный subtaskOrder уже показывает порядок, которого на
      // сервере нет — без invalidate это расхождение так и останется на
      // экране до следующего чужого изменения.
      console.error("Не удалось сохранить порядок подзадач", err);
      await qc.invalidateQueries({ queryKey: ["tasks"] });
    } finally {
      persistingSubtaskOrder.current = false;
    }
  }

  // Owner 2026-08-10: a new task must start with NO due date (Todoist-style
  // — undated tasks land in Inbox, "Сегодня" only shows what was actually
  // put there). Edit mode overwrites this from existingTask.due_date right
  // below, so an existing task keeps its own date.
  //
  // Исключение (19.08.2026): создание ИЗ раздела «Сегодня» — там кнопка
  // передаёт ?due=today, и срок проставляется сразу («логично, если я и
  // сегодня создаю»). Правило выше при этом в силе: из любого другого
  // раздела задача заводится без срока.
  const [dueDate, setDueDate] = useState<string | null>(
    searchParams.get("due") === "today" ? todayStr() : null,
  );
  // Час начала и длительность — под календарную развёртку раздела «День»
  // (18.08.2026). Живут отдельными полями, а не внутри dueDate: срок в
  // проекте всюду сравнивается как голая дата «ГГГГ-ММ-ДД», и подмешивание
  // времени сломало бы эти сравнения (см. lib/date.ts).
  const [startTime, setStartTime] = useState<string | null>(null);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  // Повтор задачи (миграция 049) — живёт только вместе со сроком, как
  // время: без даты серию не построить.
  const [runRepeat, setRunRepeat] = useState<string>("none");
  const [repeatUntil, setRepeatUntil] = useState<string | null>(null);
  // undefined = "not touched yet" (create mode falls back to the user's
  // first project); null = "explicitly no project" — reachable in edit
  // mode for a task that lives in Inbox, AND now in create mode too: the
  // Inbox board's per-column "Добавить задачу" pill (InboxScreen.tsx) links
  // here with a `project` query param so the task lands in the same column
  // it was created from — `?project=none` for the "Без проекта" column,
  // `?project=<id>` for a real project column. Read once via useState's
  // lazy initializer (not an effect): this only needs to seed the very
  // first render, same as useEffect's edit-mode hydration below but for
  // create mode, which has no existingTask to hydrate from.
  const [projectId, setProjectId] = useState<string | null | undefined>(() => {
    if (isEdit) return undefined;
    const p = searchParams.get("project");
    if (p === null) return undefined;
    return p === "none" ? null : p;
  });
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Snapshot the loaded task into local form state exactly once — further
  // background refetches (e.g. from another mutation's invalidation) must
  // not clobber whatever the user is mid-editing.
  useEffect(() => {
    if (isEdit && existingTask && !hydrated) {
      setTitle(existingTask.title);
      setDesc(existingTask.description || "");
      setAssignee(existingTask.assignee_id || undefined);
      setPriority(existingTask.priority);
      setSelectedLabelIds(existingTask.labels.map((l) => l.id));
      setDueDate(existingTask.due_date);
      setStartTime(existingTask.start_time ?? null);
      setDurationMin(existingTask.duration_min ?? null);
      setRunRepeat(existingTask.run_repeat ?? "none");
      setRepeatUntil(existingTask.repeat_until ?? null);
      setProjectId(existingTask.project_id);
      setHydrated(true);
    }
  }, [isEdit, existingTask, hydrated]);

  // useGuardedCallback is a hook (useRef × 3 + useCallback) — it MUST run
  // on every render with a stable call order, so it has to sit above the
  // early `return`s below (isEdit's loading/not-found/not-hydrated guards
  // — those gate JSX, not hook calls). The closure references
  // buildDirtyPatch/effectiveProjectId/localSubtasks, all declared further
  // down: safe, because this inner function only actually runs on a click,
  // long after the whole component body (and those consts) has finished
  // executing for that render — a plain JS closure-over-later-const, not a
  // hook-order issue.
  //
  // mutateAsync (not .mutate) is required — see useGuardedCallback's own
  // doc: the lock has to cover the actual network round-trip, not just the
  // synchronous call. No onError/try-catch needed: React Query populates
  // createTask.error/updateTask.error before rejecting, and the
  // ErrorBanner below reads straight from that mutation state (same
  // pattern LabelsField already uses for its own submit).
  const handleSave = useGuardedCallback(async () => {
    if (!title.trim()) return;
    if (isEdit && id) {
      const patch = buildDirtyPatch();
      if (Object.keys(patch).length > 0) {
        await updateTask.mutateAsync({ id, ...patch });
      }
      // replace, а не push (правка Максима 15.08.2026): иначе история
      // становится «карточка → форма → карточка», и «назад» из карточки
      // честно возвращает в форму редактирования. Выйти получалось только
      // крестиком из формы, а «Готово» зацикливало: сохранил → назад →
      // снова форма → сохранил → снова форма. Замена убирает форму из
      // истории — «назад» ведёт туда, откуда задачу открыли.
      navigate(`/task/${id}`, { replace: true });
    } else {
      // Server creates the task and its subtasks in one transaction (see
      // AGENT-API.md §Tasks, `subtasks` param) — no follow-up requests, no
      // half-created task if the connection drops mid-way.
      const created = await createTask.mutateAsync({
        title: title.trim(),
        description: desc.trim() || undefined,
        due_date: dueDate || undefined,
        // Только вместе со сроком — сервер отвергает время без даты, а
        // поле в интерфейсе без срока и не показывается.
        start_time: dueDate ? (startTime ?? undefined) : undefined,
        duration_min:
          dueDate && startTime ? (durationMin ?? undefined) : undefined,
        // Повтор — только вместе со сроком.
        run_repeat: dueDate ? runRepeat || "none" : undefined,
        repeat_until:
          dueDate && runRepeat && runRepeat !== "none"
            ? (repeatUntil ?? undefined)
            : undefined,
        project_id: effectiveProjectId ?? undefined,
        priority,
        assignee_id: assignee,
        label_ids: selectedLabelIds,
        subtasks: localSubtasks.length > 0 ? localSubtasks : undefined,
      });

      // Файлы — единственное, что нельзя было отправить вместе с задачей:
      // вложение принадлежит задаче, а её идентификатор появился только
      // сейчас. Отсюда и порядок: сначала задача, потом её файлы.
      //
      // Ошибка на этом шаге НЕ возвращает в форму: задача уже создана, и
      // повторное «Готово» завело бы вторую такую же. Поэтому сообщаем,
      // что именно не легло, и уходим в карточку — оттуда файл можно
      // дослать через «Изменить», не плодя дублей.
      if (newFiles.length > 0) {
        const failed: string[] = [];
        for (const file of newFiles) {
          try {
            await uploadAttachment(created.task.id, file, "task");
          } catch {
            failed.push(file.name);
          }
        }
        if (failed.length > 0) {
          await alert(
            `Задача создана, но файлы не приложились: ${failed.join(", ")}. Откройте задачу и попробуйте ещё раз.`,
          );
        }
        // В карточку, а не в «Входящие»: приложенное видно сразу, и в
        // случае осечки понятно, чего не хватает.
        navigate(`/task/${created.task.id}`);
        return;
      }
      // Назад, откуда пришли: задачу заводят и из «Ежедневника», и из
      // проекта, и из «Планирования» — уводить всех в один список
      // неправильно. Раньше здесь были «Входящие» (экран удалён
      // 26.08.2026: «зачем эти входящие, они по сути часть ежедневника»).
      navigate(-1);
    }
  });
  const isSaving = createTask.isPending || updateTask.isPending;

  // ── Кнопка микрофона — свой ASR, не сторонний инструмент ──
  // Superwhisper (macOS/Windows/iOS) не покрывает все устройства, с
  // которых открыт этот веб-апп (в частности Linux) — см. память
  // maksim-uses-superwhisper-mac.md. Голос записывается прямо в браузере
  // и уходит на локальный ASR-сервис через свой же backend
  // (server/src/routes/transcribe.ts), затем текст проходит ЧЕРЕЗ ТОТ ЖЕ
  // parseDictation, что и Superwhisper-диктовка ниже (applyDictationParse)
  // — маркеры #Проект/!приоритет/дата разбираются одинаково независимо от
  // того, откуда взялся текст.
  //
  // Хуки объявлены здесь, ДО веток isEdit/taskLoading/hydrated ниже (те же
  // правила хуков, что и у useGuardedCallback выше) — иначе на части
  // рендеров (загрузка/edit-режим) они бы не вызывались вовсе.
  // Одна кнопка, три цели: пишет в то поле, где владелец последний раз
  // ставил курсор (title по умолчанию — то же поведение, что было раньше,
  // пока полей для диктовки было только одно). onFocus на title/desc и на
  // поле подзадачи (AddSubtaskRow) ниже держит voiceTarget в актуальном
  // состоянии; recording уводит фокус на саму кнопку, но state, в отличие
  // от document.activeElement, переживает это без изменений.
  const [voiceTarget, setVoiceTarget] = useState<"title" | "desc" | "subtask">(
    "title",
  );
  // Источник последней диктовки — «на устройстве» (Apple Intelligence) или
  // «через сервер» (18.08.2026, просьба «как понять, что реально работает
  // локально» — выключать Wi-Fi ради проверки ломает всё приложение
  // целиком, не только эту фичу). null — ещё ни разу не диктовали в этой
  // сессии формы, подпись не показываем.
  // Три значения вместо двух: "device" не различало Whisper и системную
  // диктовку Apple, а это разные механизмы с разным качеством.
  const [voiceSource, setVoiceSource] = useState<
    "whisper" | "apple" | "server" | null
  >(null);
  // Черновик текста для поля «Добавить подзадачу...» — поднят сюда из
  // AddSubtaskRow (owner 2026-08-13), иначе кнопке диктовки некуда было бы
  // писать: у некотролируемого input своего state снаружи не видно.
  const [subtaskInput, setSubtaskInput] = useState("");
  // Owner 2026-08-13 (третий заход по концепции): полноэкранная анимация
  // сама по себе «красиво, симпатично», но как отдельная кнопка внизу
  // формы — «не туда, ни сюда»: перекрывает всю форму, а поле для записи
  // выбирать было уже негде. Правильное место — рядом с клавиатурой, как
  // системная accessory-панель iOS («стрелочки, свернуть клавиатуру»), но
  // сайты не могут добавить туда свою кнопку — это закрытый нативный UI,
  // недоступный из веба (проверено, не наобум). Вместо этого — своя
  // всплывающая панель, прижатая к границе клавиатуры через уже
  // существующий --kb-inset (useVisualViewportInset, подключён в
  // Layout.tsx). Показывается, только пока фокус реально в title/desc/поле
  // подзадачи — setTimeout на blur даёт запасные 100мс, чтобы не мигать при
  // переключении фокуса между этими двумя полями (blur одного срабатывает
  // раньше focus другого).
  const [keyboardFieldFocused, setKeyboardFieldFocused] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFieldFocus = (target: "title" | "desc" | "subtask") => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    setVoiceTarget(target);
    setKeyboardFieldFocused(true);
  };
  const handleFieldBlur = () => {
    blurTimeoutRef.current = setTimeout(
      () => setKeyboardFieldFocused(false),
      100,
    );
  };
  const handleStructureWithAI = async (textToProcess?: string) => {
    const raw =
      typeof textToProcess === "string"
        ? textToProcess
        : `${title}\n${desc}`.trim();
    if (!raw) {
      await alert(
        "Введите или надиктуйте текст в название или заметку перед структурированием.",
      );
      return;
    }
    setIsStructuring(true);
    try {
      hapticGrab();
      const res = await structureTaskWithAI.mutateAsync(raw);
      if (res.title) setTitle(res.title);
      if (res.description) setDesc(res.description);
      if (res.dueDate) {
        setDueDate(res.dueDate.slice(0, 10));
        const timeMatch = res.dueDate.match(/(?:T|\s)(\d{2}:\d{2})/);
        if (timeMatch) setStartTime(timeMatch[1]);
      }
      if ((res as any).startTime) {
        setStartTime((res as any).startTime);
        if (!res.dueDate) setDueDate(todayStr());
      }
      if (res.priority) setPriority(res.priority);
      if (Array.isArray(res.subtasks) && res.subtasks.length > 0) {
        if (isEdit && id) {
          for (const st of res.subtasks) {
            await createSubtask.mutateAsync(st);
          }
        } else {
          setLocalSubtasks((prev) =>
            Array.from(new Set([...prev, ...res.subtasks])),
          );
        }
      }
      hapticDrop();
    } catch (e: any) {
      console.error("AI Structure error:", e);
      await alert(
        `Не удалось структурировать задачу: ${e?.message || "модель не ответила вовремя"}. Проверьте связь с сервером 192.168.1.110 в Настройках.`,
      );
    } finally {
      setIsStructuring(false);
    }
  };

  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text, source } = await transcribeAudio.mutateAsync(blob);
      setVoiceSource(source);
      if (voiceTarget === "desc") {
        setDesc(combineDictatedText(desc, text));
      } else if (voiceTarget === "subtask") {
        setSubtaskInput((prev) => combineDictatedText(prev, text));
      } else {
        const combined = combineDictatedText(title, text);
        if (isEdit) {
          setTitle(combined);
        } else {
          const parsed = parseDictation(combined);
          setTitle(parsed.title);
          if (parsed.dueDate) {
            setDueDate(parsed.dueDate);
            if (parsed.startTime) setStartTime(parsed.startTime);
          } else if (parsed.startTime) {
            setDueDate(todayStr());
            setStartTime(parsed.startTime);
          }
          if (parsed.priority) setPriority(parsed.priority);
          if (parsed.projectName) {
            const match = findProjectByName(projects, parsed.projectName);
            if (match) setProjectId(match.id);
          }
          applyParsedLabel(parsed.labelName);
        }
      }
    } catch {
      // transcribeAudio.error уже несёт причину
    } finally {
      mic.finish();
    }
  });
  const micError =
    mic.error ?? (transcribeAudio.isError ? transcribeAudio.error : null);
  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  })();

  // Автостарт диктовки при переходе по deep link (taskflow://dictate)
  const autoDictateDone = useRef(false);
  useEffect(() => {
    const shouldDictate =
      searchParams.get("dictate") === "1" ||
      searchParams.get("autoDictate") === "1";
    if (shouldDictate && !autoDictateDone.current && mic.state === "idle") {
      autoDictateDone.current = true;
      setVoiceTarget("title");
      const t = setTimeout(() => {
        hapticGrab();
        mic.start();
      }, 300);
      return () => clearTimeout(t);
    }
  }, [searchParams, mic.state, mic.start]);

  // ⚠️ Разбор маркеров диктовки — ДО ранних return ниже, а не рядом со
  // своей функцией. Хук после условного выхода вызывается не на каждом
  // рендере: пока задача грузится, компонент выходит раньше и хуков
  // меньше, после загрузки — больше, и React падает с «Rendered more
  // hooks than during the previous render». Именно этот краш ловил
  // владелец при нажатии «Изменить» (19.08.2026): экран пустел целиком.
  //
  // Ref пустой заглушкой, а не самой функцией: applyDictationParse
  // объявлена ниже через const, подъёма у неё нет — обращение отсюда
  // упало бы с «Cannot access before initialization». Реальная ссылка
  // проставляется в .current сразу после объявления функции (это уже не
  // хук, порядок вызовов не нарушает).
  const applyParseRef = useRef<() => void>(() => {});
  useEffect(() => {
    // setTimeout(0), а не прямой вызов: событие летит синхронно сразу за
    // вставкой текста, когда React ещё не применил новое значение заголовка —
    // разбор прочитал бы предыдущее. Отложенный вызов приходит после коммита,
    // и ref уже указывает на замыкание со свежим title.
    const onDictation = () => {
      window.setTimeout(() => applyParseRef.current(), 0);
    };
    window.addEventListener("app-dictation-inserted", onDictation);
    return () =>
      window.removeEventListener("app-dictation-inserted", onDictation);
  }, []);

  if (isEdit && taskLoading) {
    return <Loading variant="block" />;
  }
  if (isEdit && (!existingTask || taskError)) {
    return (
      <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
    );
  }
  if (isEdit && !hydrated) {
    return <Loading variant="block" />;
  }

  // Projects/labels/agents failing to load (server down, offline) must not
  // render as a quietly-empty-but-functional form — "Входящие" + "Меток
  // пока нет" + "Выбрать исполнителя" all look like valid empty states
  // otherwise, and the user only discovers the outage after filling the
  // whole form and hitting «Готово».
  const refDataError = agentsError || projectsError || labelsError;

  // `??` alone would be wrong here: `null` is a real, distinct value
  // ("explicitly no project", set by the ?project=none pill or an edit-mode
  // Inbox task) and `??` treats null exactly like undefined, silently
  // falling back to projects[0] and putting a "no project" task into the
  // user's first project instead. Only `undefined` ("not touched yet")
  // should fall back; `null` must pass through untouched in both modes.
  const effectiveProjectId =
    projectId === undefined ? (isEdit ? null : projects[0]?.id) : projectId;
  const currentProject = projects.find((p) => p.id === effectiveProjectId);

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(labelId)
        ? prev.filter((l) => l !== labelId)
        : [...prev, labelId],
    );
  };

  // Edit mode sends only what actually changed. Sending every field
  // unconditionally (the earlier version of this screen) re-fires the
  // server's "assignee changed" notification on *every* save — it has no
  // did-it-actually-change check (server/src/routes/tasks.ts) — and does a
  // pointless label_ids DELETE+INSERT even when labels are untouched.
  const buildDirtyPatch = (): Omit<UpdateTaskInput, "id"> => {
    if (!existingTask) return {};
    const patch: Omit<UpdateTaskInput, "id"> = {};
    const nextTitle = title.trim();
    const nextDesc = desc.trim();
    const nextAssignee = assignee ?? null;
    const origLabelIds = existingTask.labels
      .map((l) => l.id)
      .slice()
      .sort();
    const nextLabelIds = [...selectedLabelIds].sort();

    if (nextTitle !== existingTask.title) patch.title = nextTitle;
    if (nextDesc !== (existingTask.description || ""))
      patch.description = nextDesc;
    if (dueDate !== existingTask.due_date) patch.due_date = dueDate;
    // Снятый срок уносит с собой время: иначе на сервере осталось бы
    // время без даты — состояние, которое он же сам и запрещает.
    const nextStart = dueDate ? startTime : null;
    const nextDuration = dueDate && startTime ? durationMin : null;
    if (nextStart !== (existingTask.start_time ?? null))
      patch.start_time = nextStart;
    if (nextDuration !== (existingTask.duration_min ?? null))
      patch.duration_min = nextDuration;
    // Повтор — тоже только со сроком: без даты серии нет.
    const nextRepeat = dueDate ? runRepeat || "none" : "none";
    if (nextRepeat !== (existingTask.run_repeat ?? "none"))
      patch.run_repeat = nextRepeat;
    const nextUntil = dueDate && nextRepeat !== "none" ? repeatUntil : null;
    if (nextUntil !== (existingTask.repeat_until ?? null))
      patch.repeat_until = nextUntil;
    if (effectiveProjectId !== (existingTask.project_id ?? null))
      patch.project_id = effectiveProjectId;
    if (priority !== existingTask.priority) patch.priority = priority;
    if (nextAssignee !== (existingTask.assignee_id ?? null))
      patch.assignee_id = nextAssignee;
    if (JSON.stringify(origLabelIds) !== JSON.stringify(nextLabelIds))
      patch.label_ids = selectedLabelIds;

    return patch;
  };

  // Разбор голосовой диктовки (Superwhisper печатает готовый текст прямо в
  // это поле на уровне ОС — сюда долетает уже обычный текст, аудио тут ни
  // при чём) — распознаёт «завтра», «#Проект», «!приоритет» и переносит их
  // в соответствующие поля, вырезая маркеры из заголовка. Синхронно, без
  // сети (см. src/lib/dictationParser.ts).
  //
  // Только create-режим: в редактировании заголовок уже осмысленный текст
  // существующей задачи, а не свежая диктовка — трогать его молчаливым
  // regex-разбором при каждом blur было бы неожиданным поведением для
  // задачи, которую открыли просто чтобы поправить описание.
  //
  // Срабатывает по потере фокуса поля, а не на каждое нажатие клавиши:
  // live-разбор во время самого набора текста дёргал бы поле и переносил
  // курсор прямо под пальцами/при живой диктовке. Кнопка «Готово» лежит
  // вне этого поля (в шапке экрана), поэтому клик по ней стандартно снимает
  // фокус с textarea раньше, чем срабатывает её собственный обработчик —
  // blur успевает отработать до сохранения.
  // Метка из маркера `@Название`. Сопоставление по имени — той же функцией,
  // что и для проекта (findProjectByName принимает любой {id, name}), чтобы
  // правила совпадения не разъехались между полями. Неизвестное имя молча
  // игнорируем: новую метку по обмолвке в диктовке заводить нельзя, а
  // маркер из заголовка парсер уже вырезал — текст останется чистым.
  // Уже выбранную метку повторно не добавляем.
  const applyParsedLabel = (labelName: string | null) => {
    if (!labelName) return;
    const match = findProjectByName(labels, labelName);
    if (!match) return;
    setSelectedLabelIds((prev) =>
      prev.includes(match.id) ? prev : [...prev, match.id],
    );
  };

  const applyDictationParse = () => {
    if (isEdit) return;
    const parsed = parseDictation(title);
    if (parsed.title === title.trim()) return; // ни одного маркера — не трогаем
    setTitle(capitalizeFirst(parsed.title));
    if (parsed.dueDate) {
      setDueDate(parsed.dueDate);
      if (parsed.startTime) setStartTime(parsed.startTime);
    } else if (parsed.startTime) {
      setDueDate(todayStr());
      setStartTime(parsed.startTime);
    }
    if (parsed.priority) setPriority(parsed.priority);
    if (parsed.projectName) {
      const match = findProjectByName(projects, parsed.projectName);
      if (match) setProjectId(match.id);
    }
    applyParsedLabel(parsed.labelName);
  };
  // Свежая ссылка для слушателя, объявленного выше (см. applyParseRef):
  // функция пересоздаётся каждый рендер, слушатель вешается один раз.
  applyParseRef.current = applyDictationParse;

  return (
    // pb-4 (16px) + --kb-inset — тот же приём, что и в TaskDetailScreen
    // (см. комментарий там): дефолт переменной 0px в index.css держит
    // отступ ровно 16px, пока клавиатура закрыта, а useVisualViewportInset
    // (подключён в Layout.tsx) добавляет её высоту на WebKit, где 100dvh
    // сам не пересчитывается.
    <div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))] min-h-full">
      {/* Сообщение о файлах, не легших к уже созданной задаче (handleSave)
          — тем же диалогом, что и остальные предупреждения приложения. */}
      {dialog}
      {/* Статус ИИ — плашкой вверху экрана, под вырезом: структурирование
          занимает секунды, и подписи на самой кнопке мало (26.08.2026). */}
      <AiBusyPill visible={isStructuring} label="Структурирую задачу…" />
      <ScreenHeader
        variant="compact"
        leading={
          <button
            onClick={() => navigate(-1)}
            className="w-[44px] h-[44px] flex items-center justify-center active:scale-95"
          >
            <Icon name="x" size={18} />
          </button>
        }
        title=""
        actions={
          <button
            onClick={handleSave}
            disabled={!title.trim() || isSaving}
            /* 16px → 17px (20.08.2026). 16px в проекте — не кегль из
               шкалы, а защита полей ввода от автозума iOS (правило
               input/select/textarea в index.css), и вне полей ему делать
               нечего. Здесь это обычная кнопка навбара, а рядом в той же
               шапке заголовок набран 17px. Тем же заходом на 17px
               переведены заголовки четырёх шторок — теперь весь неполевой
               17px значит одно: «крупный, но не заголовок экрана». */
            className="text-[17px] font-semibold text-red active:opacity-70 disabled:opacity-50"
          >
            {isSaving ? "Сохранение…" : "Готово"}
          </button>
        }
      />

      {/* Save button lives in the fixed header above, not at the bottom of
          the form — this is the closest position to "прямо над кнопкой
          сохранения" that doesn't scroll the header out of first place. */}
      <ErrorBanner
        error={isEdit ? updateTask.error : createTask.error}
        fallback="Не удалось сохранить задачу. Проверьте соединение."
        variant="block"
        className="mb-4"
      />
      <ErrorBanner
        error={refDataError}
        fallback="Не удалось загрузить проекты, метки или агентов. Проверьте соединение."
        variant="block"
        className="mb-4"
      />

      {/* Title — кнопки микрофона тут нет (owner 2026-08-13, третий заход):
          она живёт в плавающей панели над клавиатурой, показывается пока
          это поле в фокусе — см. keyboardFieldFocused/handleFieldFocus
          выше и MicKeyboardBar в самом конце разметки.
          Owner 2026-08-13 (шестой заход, типографика): владелец свёл всю
          карточку к ДВУМ типоразмерам — крупный (17px, = прежний заголовок
          экрана «Новая задача»/«Изменить задачу», ScreenHeader compact-
          вариант) для лейблов-заголовков секций, мелкий (13px, = прежний
          размер лейбла «Подзадачи») для содержимого полей.
          Седьмой заход: заголовок экрана вынесен ИЗ шапки СЮДА — тем же
          лейблом, что и остальные секции («по аналогии с другими
          заголовками», прямая формулировка владельца) — ScreenHeader
          выше теперь получает title="" (шапка остаётся с X/Готово, без
          текста по центру). Заодно убран px-1, который был у всех
          лейблов секций (Подзадачи/Заметка/Назначить/Метки) и НЕ было у
          textarea/списка подзадач — реальная причина «подзадача начинается
          в одном месте, описание в другом»: список подзадач (SubtaskRow/
          AddSubtaskRow, TaskFields.tsx) донёс свой px-4 из тех времён,
          когда стоял внутри Card-рамки (убрана пятым заходом) — там он был
          нужен как внутренний отступ ОТ ГРАНИЦЫ рамки, а без рамки стал
          просто лишним сдвигом вправо. Теперь везде один общий уровень —
          левый край родительского px-4 (16px), ничего сверху не добавляет
          свой px. */}
      {/* mt-4 (16px) — девятый заход, замер: без него этот лейбл липнет
          прямо к border-b шапки (0px зазор, живой замер
          getBoundingClientRect подтвердил), потому что оба ErrorBanner
          выше рендерят null и не держат места, когда ошибок нет (обычный
          случай). 16px — тот же межблочный модуль, что mb-4 держит между
          остальными секциями формы ниже. */}
      <div className="flex items-center justify-between mb-2 mt-4">
        <div className="text-[17px] text-sub font-semibold">
          {isEdit ? "Изменить задачу" : "Новая задача"}
        </div>
        {(title.trim() || desc.trim()) && (
          <button
            type="button"
            onClick={() => handleStructureWithAI()}
            disabled={isStructuring}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold text-white bg-gradient-to-r from-[#FF2D55] to-[#FF9500] active:scale-95 transition-transform disabled:opacity-50 shadow-sm"
          >
            <Icon name="sparkles" size={12} />
            {/* Подпись кнопки НЕ меняется на «думает»: статус теперь
                плашкой вверху экрана (AiBusyPill), под вырезом — одинаково
                во всех местах, где работает ИИ. Кнопка просто гаснет. */}
            Структурировать с AI
          </button>
        )}
      </div>
      <textarea
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          applyDictationParse();
          handleFieldBlur();
        }}
        onFocus={() => handleFieldFocus("title")}
        placeholder="Название задачи"
        className="block w-full bg-transparent text-[13px] text-text placeholder:text-dim resize-none outline-none mb-4 min-h-[20px] overflow-hidden"
        rows={1}
      />

      {/* Description — Максим 18.08.2026: порядок полей должен быть
          «название → заметка → подзадачи», не наоборот — заметка это
          описание самой задачи, ей место сразу под названием, а не в
          подвале после списка шагов. Переставлена перед блоком «Подзадачи»
          ниже (был порядок «Подзадачи» → «Заметка», пятый заход 2026-08-13
          — то прежнее решение отменено этим прямым указанием, история
          осталась в git, не переписана здесь).
          Owner 2026-08-13 (шестой заход): лейбл «Заметка» — той же
          разметкой, что и лейбл «Подзадачи» ниже, крупный типоразмер
          (17px). Сам textarea — мелкий (13px), тот же приём, что и у
          названия задачи. Седьмой заход: px-1 убран — см. комментарий у
          textarea названия.
          Девятый заход (замер): убран лишний <span>-обёртка — в отличие
          от «Подзадачи» (там span нужен как flex-item рядом с кнопкой
          «Разбить»), у «Заметка» это был единственный ребёнок div'а без
          причины. Строчный span внутри блочного div даёт свой line-box
          строкой ниже (line-height от унаследованного 17px), из-за чего
          div.bottom оказывался на ~4px ниже фактического текста — gap до
          textarea измерялся 12px вместо 8px, как у «Новая задача»→
          textarea и «Подзадачи»→«Добавить подзадачу». Текст теперь прямо
          в div, тем же приёмом, что и заголовок экрана выше. */}
      <div className="text-[17px] text-sub font-semibold mb-2">Заметка</div>
      <textarea
        ref={descRef}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onFocus={() => handleFieldFocus("desc")}
        onBlur={handleFieldBlur}
        placeholder="Описание"
        className="block w-full bg-transparent text-[13px] text-sub placeholder:text-dim resize-none outline-none mb-4 min-h-[40px] overflow-hidden"
        rows={1}
      />

      {/* ── Subtasks — owner 2026-08-13 (пятый заход): переставлены сразу
          под название, перед описанием (было: после карточки Срок/Проект/
          Приоритет) — так поле «Добавить подзадачу» больше не оказывается
          далеко внизу формы, за карточкой и AI-блоком: раньше переключение
          фокуса между title/desc и этим полем гоняло страницу через весь
          этот путь, и --kb-inset (useVisualViewportInset) не успевал
          пересчитаться, пока шёл автоскролл к полю — плавающая кнопка
          диктовки на миг проваливалась к низу экрана и «подтягивалась»
          обратно только после того, как скролл останавливался. Соседство с
          title сокращает этот путь до одного экрана. Список — БЕЗ Card-
          обёртки (bg-card/рамка/разделители), в общем потоке страницы, тем
          же приёмом, что и обычный текст: владелец явно попросил убрать
          карточку, оставить только заголовок и кнопку «Разбить».
          Седьмой заход: убран px-1 — см. комментарий у textarea названия
          выше.
          Десятый заход (18.08.2026): «Заметка» переставлена ВЫШЕ этого
          блока (см. её комментарий) — соседство с title, ради которого
          подзадачи сюда и подняли пятым заходом, этим не портится: оба
          поля всё ещё в одном экране без скролла, просто заметка теперь
          между ними. */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[17px] text-sub font-semibold">Подзадачи</span>
      </div>

      <div>
        {/* No Card wrapper here on purpose (see comment above) — rows lost
            the shared bg-card/rounded frame and the border-t dividers Card
            used to draw between them. Their own px-4/px-[14px] (leftover
            from standing inside that Card) was removed a couple owner
            passes later — see AddSubtaskRow's own comment (TaskFields.tsx)
            for why.
            No own mb-4 here (девятый заход, замер) — AddSubtaskRow now
            carries mb-4 itself (same pattern as title/desc textarea), so
            this wrapper doesn't double it. See AddSubtaskRow's comment for
            the measured before/after. */}
        {isEdit
          ? (() => {
              const byId = new Map(
                (existingTask?.subtasks || []).map((s) => [s.id, s]),
              );
              // subtaskOrder — источник порядка при рендере (не сырой
              // existingTask.subtasks): во время resync-паузы (см. эффект
              // выше) это единственное, что не прыгает при живом drag.
              // Подзадача, которую сервер ещё не прислал (только что
              // созданная — invalidate ещё в полёте), молча пропускается,
              // отфильтровывается ниже вместе с любым битым id.
              const ordered = subtaskOrder
                .map((sid) => byId.get(sid))
                .filter((s): s is NonNullable<typeof s> => !!s);
              return (
                <>
                  <DndContext
                    sensors={subtaskSensors}
                    collisionDetection={closestCenter}
                    onDragStart={(e) => {
                      setDraggingSubtask(true);
                      hapticGrab();
                      lastSubtaskOverRef.current = String(e.active.id);
                    }}
                    // Строка перепрыгнула соседа — тот же «щелчок», что на
                    // доске и в сетке часов.
                    onDragOver={(e) => {
                      const overId = e.over ? String(e.over.id) : null;
                      if (overId !== lastSubtaskOverRef.current) {
                        lastSubtaskOverRef.current = overId;
                        if (overId) hapticCross();
                      }
                    }}
                    onDragEnd={handleSubtaskDragEnd}
                    onDragCancel={() => {
                      setDraggingSubtask(false);
                      lastSubtaskOverRef.current = null;
                    }}
                  >
                    <SortableContext
                      items={ordered.map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {ordered.map((st) => (
                        <SortableSubtaskRow
                          key={st.id}
                          id={st.id}
                          title={st.title}
                          done={st.done}
                          onRename={(t) =>
                            updateSubtask.mutate({ id: st.id, title: t })
                          }
                          onDelete={() => deleteSubtask.mutate(st.id)}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  <AddSubtaskRow
                    onAdd={(t) => createSubtask.mutate(t)}
                    value={subtaskInput}
                    onChange={setSubtaskInput}
                    onFocus={() => handleFieldFocus("subtask")}
                    onBlur={handleFieldBlur}
                  />
                </>
              );
            })()
          : [
              ...localSubtasks.map((s, i) => (
                <div key={i} className="flex items-center gap-3 py-[12px]">
                  <span className="text-[14px] text-text flex-1">{s}</span>
                  <button
                    onClick={() =>
                      setLocalSubtasks(localSubtasks.filter((_, j) => j !== i))
                    }
                    className="p-2 -m-1 shrink-0"
                  >
                    <Icon name="x" size={14} className="text-dim" />
                  </button>
                </div>
              )),
              <AddSubtaskRow
                key="add"
                onAdd={(t) => setLocalSubtasks((prev) => [...prev, t])}
                value={subtaskInput}
                onChange={setSubtaskInput}
                onFocus={() => handleFieldFocus("subtask")}
                onBlur={handleFieldBlur}
              />,
            ]}
        <ErrorBanner
          error={
            createSubtask.error ?? updateSubtask.error ?? deleteSubtask.error
          }
          fallback="Не удалось изменить подзадачи. Проверьте соединение."
          variant="block"
          className="mt-2"
        />
      </div>

      {/* ── Файлы — Максим 19.08.2026: «чтобы в заметках я уже изначально
          мог прикреплять скриншоты и документы». Само поле и разница между
          созданием и правкой — в components/AttachmentsField.tsx.
          Стояли между «Заметкой» и «Подзадачами» (файл как часть заметки),
          переставлены ПОСЛЕ подзадач 20.08.2026 по прямой просьбе владельца:
          «сначала подзадача, а прикрепить файлы будет после подзадачи».
          Так наверху формы подряд идёт то, что заполняется всегда —
          название, заметка, шаги, — а вложение остаётся редким довеском и не
          разрывает этот ряд. */}
      <AttachmentsField
        taskId={isEdit ? id : undefined}
        saved={existingTask?.attachments}
        files={newFiles}
        onFilesChange={setNewFiles}
      />

      {/* ── Срок / Проект / Приоритет — mockup .card (screen 11) ── */}
      <div className="mb-4">
        <Card>
          <DueDateField
            time={startTime}
            duration={durationMin}
            onTimeChange={(t, d) => {
              setStartTime(t);
              setDurationMin(d);
            }}
            value={dueDate}
            runRepeat={runRepeat}
            onRunRepeatChange={setRunRepeat}
            repeatUntil={repeatUntil}
            onRepeatUntilChange={setRepeatUntil}
            seriesEnded={isEdit && (existingTask?.recurrence_spawned ?? 0) === 1}
            onExtendRepeat={
              isEdit && isOwner ? () => extendRepeat.mutate(id!) : undefined
            }
            extendingRepeat={extendRepeat.isPending}
            onChange={(v) => {
              setDueDate(v);
              // Дату сняли — время осиротело, убираем сразу, а не при
              // сохранении: иначе строка «Время» исчезнет, а значение
              // останется висеть в состоянии формы. Повтор тоже: серия
              // без даты не строится.
              if (!v) {
                setStartTime(null);
                setDurationMin(null);
                setRunRepeat("none");
                setRepeatUntil(null);
              }
            }}
          />
          <div>
            <FieldRow
              icon="hash"
              label="Проект"
              value={currentProject?.name || "Входящие"}
              chevronOpen={showProjectPicker}
              onClick={() => setShowProjectPicker((o) => !o)}
            />
            {showProjectPicker && (
              <div className="border-t border-stroke">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setProjectId(p.id);
                      setShowProjectPicker(false);
                    }}
                    className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-white/[0.04] transition-colors"
                  >
                    <Icon name="hash" size={16} style={{ color: p.color }} />
                    <span className="text-[14px] text-text flex-1">
                      {p.name}
                    </span>
                    {p.id === effectiveProjectId && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                ))}
                {projects.length === 0 && (
                  <div className="px-4 py-3 text-[13px] text-dim">
                    Проектов пока нет
                  </div>
                )}
              </div>
            )}
          </div>
          <PriorityField value={priority} onChange={setPriority} />
          <LabelsField
            labels={labels}
            selectedIds={selectedLabelIds}
            onToggle={toggleLabel}
          />
        </Card>
      </div>

      {/* ── Assignee (tappable → picker) ── */}
      <div className="text-[13px] text-sub font-semibold mb-2">Назначить</div>
      <div className="bg-card rounded-[14px] overflow-hidden mb-4">
        {showAssigneePicker ? (
          <>
            {assigneeOptions.map((u) => (
              <button
                key={u.id}
                onClick={() => {
                  setAssignee(assignee === u.id ? undefined : u.id);
                  setShowAssigneePicker(false);
                }}
                className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-card2 transition-colors"
              >
                <Avatar
                  initials={u.initials}
                  color={u.avatar_color}
                  avatar_url={u.avatar_url}
                  size={32}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-text truncate">{u.name}</div>
                  {/* Кто на связи — видно там, где это и решает: назначать
                      задачу агенту, который сейчас не отвечает, смысла мало
                      (просьба Максима 14.08.2026 — статус нужен в момент
                      выбора исполнителя, а не только в настройках). У людей
                      строки нет: их присутствие ни на что не влияет. */}
                  {u.type === "ai" && (
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-[6px] h-[6px] rounded-full shrink-0 ${
                          u.status === "online" ? "bg-green" : "bg-dim"
                        }`}
                      />
                      <span
                        className={`text-[12px] ${
                          u.status === "online" ? "text-green" : "text-dim"
                        }`}
                      >
                        {u.status === "online" ? "на связи" : "не в сети"}
                      </span>
                    </div>
                  )}
                </div>
                <span className="text-[12px] text-sub bg-card2 px-2 py-0.5 rounded shrink-0">
                  {roleLabel(u.role)}
                </span>
                {assignee === u.id ? (
                  <Icon name="check" size={18} className="text-red" />
                ) : (
                  <Icon name="chevron" size={16} className="text-dim" />
                )}
              </button>
            ))}
            <button
              onClick={() => setShowAssigneePicker(false)}
              className="w-full text-center text-[13px] text-sub py-2"
            >
              Отмена
            </button>
          </>
        ) : (
          <>
            {assignee ? (
              (() => {
                const u = assigneeOptions.find((us) => us.id === assignee);
                if (!u) return null;
                return (
                  <button
                    onClick={() => setShowAssigneePicker(true)}
                    className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-card2 transition-colors"
                  >
                    <Avatar
                      initials={u.initials}
                      color={u.avatar_color}
                      avatar_url={u.avatar_url}
                      size={32}
                    />
                    <div className="flex-1">
                      <div className="text-[14px] text-text">{u.name}</div>
                    </div>
                    <span className="text-[12px] text-sub bg-card2 px-2 py-0.5 rounded">
                      {roleLabel(u.role)}
                    </span>
                    <Icon name="check" size={18} className="text-red" />
                  </button>
                );
              })()
            ) : (
              <button
                onClick={() => setShowAssigneePicker(true)}
                className="w-full flex items-center gap-3 py-3 px-4 text-left text-sub active:bg-card2 transition-colors"
              >
                <div className="w-[32px] h-[32px] rounded-full border-2 border-dashed border-stroke flex items-center justify-center">
                  <Icon name="plus" size={16} className="text-dim" />
                </div>
                <span className="text-[14px]">Выбрать исполнителя</span>
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Диктовка — owner 2026-08-13, третий заход по концепции: не
          отдельная кнопка в потоке формы (перекрывала форму, некуда было
          целиться), а панель над клавиатурой (MicKeyboardBar), которая
          появляется, только когда реально набираешь текст в title/desc/
          поле подзадачи (четвёртый заход: то же поведение распространено
          на AddSubtaskRow) — см. keyboardFieldFocused выше. Прижата к
          правому краю (right-[18px] в самом MicKeyboardBar), максимально
          вправо. Полноэкранное кольцо (MicOverlay) остаётся тем же —
          «красиво, симпатично» уже подтверждено, менялось только МЕСТО
          входа в запись, не сама анимация. ErrorBanner — всегда в потоке
          формы, не только при открытой клавиатуре: ошибка распознавания
          может прийти уже после того, как клавиатура закрылась. */}
      <ErrorBanner
        error={micError}
        fallback="Не удалось распознать речь. Проверьте соединение."
        variant="block"
        className="mb-4"
      />
      {/* Источник последней диктовки (18.08.2026) — «на устройстве» (Apple
          Intelligence, без сети) или «через сервер» (.110). Держится до
          следующей диктовки в этой же форме, не auto-hide — не мигающий
          toast, а факт, который можно спокойно прочитать в своём темпе. */}
      {voiceSource && mic.state === "idle" && (
        <p className="text-[12px] text-dim mb-4 -mt-2">
          Распознано{" "}
          {voiceSource === "whisper"
            ? "Whisper на устройстве"
            : voiceSource === "apple"
              ? "диктовка Apple"
              : "через сервер"}
        </p>
      )}
      {keyboardFieldFocused && mic.state === "idle" && (
        <MicKeyboardBar
          onStart={mic.start}
          ariaLabel={
            voiceTarget === "desc"
              ? "Надиктовать описание"
              : voiceTarget === "subtask"
                ? "Надиктовать подзадачу"
                : "Надиктовать название"
          }
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
