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
  PointerSensor,
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
import { useLabels, useCreateLabel } from "../api/labels";
import { useAgents } from "../api/agents";
import { useCreateTask, useTask, useUpdateTask } from "../api/tasks";
import {
  useCreateSubtask,
  useDeleteSubtask,
  useUpdateSubtask,
} from "../api/subtasks";
import {
  useSuggestSubtasksForDraft,
  useSuggestSubtasksForTask,
} from "../api/ai";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import {
  Card,
  FieldRow,
  DueDateField,
  PriorityField,
  LabelsField,
  SubtaskRow,
  AddSubtaskRow,
} from "../components/TaskFields";
import { MicOverlay } from "../components/MicOverlay";
import { MicKeyboardBar } from "../components/MicKeyboardBar";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import {
  combineDictatedText,
  findProjectByName,
  parseDictation,
} from "../lib/dictationParser";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import type { UpdateTaskInput } from "../api/tasks";

// Тот же приём, что SortableBoardCard у TaskBoard.tsx: dnd-kit даёт
// transform/transition/listeners, но реальная ручка — отдельный
// sub-элемент внутри SubtaskRow (см. её комментарий), не вся строка,
// иначе тап по названию (переименование) и драг спорили бы за один жест.
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
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <SubtaskRow
        title={title}
        done={done}
        onRename={onRename}
        onDelete={onDelete}
        dragHandleListeners={listeners}
        dragHandleAttributes={attributes}
        setDragHandleRef={setActivatorNodeRef}
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
  const { data: projects = [], isError: projectsError } = useProjects();
  const { data: labels = [], isError: labelsError } = useLabels();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const createLabel = useCreateLabel();
  const {
    data: existingTask,
    isLoading: taskLoading,
    isError: taskError,
  } = useTask(id);
  const createSubtask = useCreateSubtask(id || "");
  const updateSubtask = useUpdateSubtask();
  const deleteSubtask = useDeleteSubtask();
  // Обе ветки вызываются безусловно (правило хуков) — какую из двух
  // реально дёргать (и чьи isPending/error читать), решает isEdit ниже,
  // тем же паттерном, что createTask/updateTask выше.
  const suggestForTask = useSuggestSubtasksForTask(id || "");
  const suggestForDraft = useSuggestSubtasksForDraft();

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
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

  const subtaskSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleSubtaskDragEnd(event: DragEndEvent) {
    setDraggingSubtask(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = subtaskOrder.indexOf(String(active.id));
    const newIndex = subtaskOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(subtaskOrder, oldIndex, newIndex);
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
  // Предложение локальной модели, ждущее подтверждения владельцем —
  // ничего в нём не сохранено, пока он не нажал «Добавить выбранные».
  // Второй клик по «Разбить» полностью заменяет этот список, а не
  // добавляет к нему.
  const [suggestions, setSuggestions] = useState<
    { text: string; checked: boolean }[] | null
  >(null);
  const [confirmingSuggestions, setConfirmingSuggestions] = useState(false);
  // Owner 2026-08-10: a new task must start with NO due date (Todoist-style
  // — undated tasks land in Inbox, "Сегодня" only shows what was actually
  // put there). Edit mode overwrites this from existingTask.due_date right
  // below, so an existing task keeps its own date.
  const [dueDate, setDueDate] = useState<string | null>(null);
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
      await createTask.mutateAsync({
        title: title.trim(),
        description: desc.trim() || undefined,
        due_date: dueDate || undefined,
        project_id: effectiveProjectId ?? undefined,
        priority,
        assignee_id: assignee,
        label_ids: selectedLabelIds,
        subtasks: localSubtasks.length > 0 ? localSubtasks : undefined,
      });
      navigate("/inbox");
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
  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text } = await transcribeAudio.mutateAsync(blob);
      if (voiceTarget === "desc") {
        // Описание — произвольный текст, без parseDictation: маркеры
        // #Проект/!приоритет/дата разбираются только в заголовке.
        setDesc(combineDictatedText(desc, text));
      } else if (voiceTarget === "subtask") {
        // Подзадача — тоже произвольный текст, без parseDictation: маркеры
        // #Проект/!приоритет/дата в названии подзадачи не имеют смысла, это
        // формат только для заголовка задачи.
        setSubtaskInput((prev) => combineDictatedText(prev, text));
      } else {
        const combined = combineDictatedText(title, text);
        if (isEdit) {
          setTitle(combined);
        } else {
          const parsed = parseDictation(combined);
          setTitle(parsed.title);
          if (parsed.dueDate) setDueDate(parsed.dueDate);
          if (parsed.priority) setPriority(parsed.priority);
          if (parsed.projectName) {
            const match = findProjectByName(projects, parsed.projectName);
            if (match) setProjectId(match.id);
          }
          applyParsedLabel(parsed.labelName);
        }
      }
    } catch {
      // transcribeAudio.error уже несёт причину — ErrorBanner ниже её
      // покажет, дублировать текст здесь не нужно.
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

  // Дёргает эндпоинт разбивки — существующая задача шлёт свой id (сервер
  // сам подтянет title/description из БД), но тело всё равно везёт текущие
  // значения формы: если владелец правит заголовок/описание и ещё не
  // сохранил, разбивать нужно по свежему тексту, а не по тому, что лежит
  // в базе.
  const suggestPending = isEdit
    ? suggestForTask.isPending
    : suggestForDraft.isPending;
  const suggestError = isEdit ? suggestForTask.error : suggestForDraft.error;
  const handleSuggestSubtasks = useGuardedCallback(async () => {
    if (!title.trim()) return;
    const body = {
      title: title.trim(),
      description: desc.trim() || undefined,
    };
    const res =
      isEdit && id
        ? await suggestForTask.mutateAsync(body)
        : await suggestForDraft.mutateAsync(body);
    setSuggestions(res.subtasks.map((text) => ({ text, checked: true })));
  });

  const toggleSuggestion = (index: number) => {
    setSuggestions((prev) =>
      prev
        ? prev.map((s, i) => (i === index ? { ...s, checked: !s.checked } : s))
        : prev,
    );
  };

  // Подтверждённые подзадачи попадают ровно туда же, куда обычные,
  // добавленные вручную через AddSubtaskRow ниже: у существующей задачи —
  // сразу в API (последовательно, не Promise.all — сервер считает позицию
  // как MAX+1 на каждый запрос, параллельные вставки схлопнутся в
  // одинаковую позицию), у черновика — в localSubtasks, откуда их заберёт
  // handleSave при создании задачи.
  const handleConfirmSuggestions = useGuardedCallback(async () => {
    if (!suggestions) return;
    const chosen = suggestions.filter((s) => s.checked).map((s) => s.text);
    if (chosen.length === 0) return;
    setConfirmingSuggestions(true);
    try {
      if (isEdit && id) {
        for (const text of chosen) {
          await createSubtask.mutateAsync(text);
        }
      } else {
        setLocalSubtasks((prev) => [...prev, ...chosen]);
      }
      setSuggestions(null);
    } finally {
      setConfirmingSuggestions(false);
    }
  });

  if (isEdit && taskLoading) {
    return <div className="px-4 py-8 text-center text-sub">Загрузка…</div>;
  }
  if (isEdit && (!existingTask || taskError)) {
    return (
      <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
    );
  }
  if (isEdit && !hydrated) {
    return <div className="px-4 py-8 text-center text-sub">Загрузка…</div>;
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

  const handleCreateLabel = async (name: string) => {
    const label = await createLabel.mutateAsync({ name });
    setSelectedLabelIds((prev) => [...prev, label.id]);
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
    if (parsed.title === title) return; // ни одного маркера — не трогаем
    setTitle(parsed.title);
    if (parsed.dueDate) setDueDate(parsed.dueDate);
    if (parsed.priority) setPriority(parsed.priority);
    if (parsed.projectName) {
      const match = findProjectByName(projects, parsed.projectName);
      if (match) setProjectId(match.id);
    }
    applyParsedLabel(parsed.labelName);
  };

  return (
    // pb-4 (16px) + --kb-inset — тот же приём, что и в TaskDetailScreen
    // (см. комментарий там): дефолт переменной 0px в index.css держит
    // отступ ровно 16px, пока клавиатура закрыта, а useVisualViewportInset
    // (подключён в Layout.tsx) добавляет её высоту на WebKit, где 100dvh
    // сам не пересчитывается.
    <div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))] min-h-full">
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
            className="text-[16px] font-semibold text-red active:opacity-70 disabled:opacity-50"
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
      <div className="text-[17px] text-sub font-semibold mb-2 mt-4">
        {isEdit ? "Изменить задачу" : "Новая задача"}
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
        <button
          onClick={handleSuggestSubtasks}
          disabled={!title.trim() || suggestPending}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-red active:opacity-70 disabled:opacity-40"
        >
          <Icon name="sparkles" size={13} />
          {suggestPending ? "Разбиваю…" : "Разбить на подзадачи"}
        </button>
      </div>
      <ErrorBanner
        error={suggestError}
        fallback="Не удалось разбить задачу на подзадачи. Проверьте, что локальная модель запущена."
        variant="block"
        className="mb-2"
      />

      {/* ── AI-предложение — ждёт подтверждения владельцем, ничего не
          создаётся, пока он не нажмёт «Добавить выбранные» ── */}
      {suggestions && (
        <div className="mb-3 bg-card rounded-2xl overflow-hidden">
          <div className="px-4 pt-3 pb-1 text-[12px] text-dim">
            Предложение модели — уберите лишнее и подтвердите
          </div>
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => toggleSuggestion(i)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left border-t border-stroke active:bg-white/[0.04] transition-colors"
            >
              <div
                className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 ${
                  s.checked ? "bg-red border-red" : "border-dim"
                }`}
              >
                {s.checked && (
                  <Icon name="check" size={12} className="text-white" />
                )}
              </div>
              <span
                className={`text-[14px] flex-1 ${
                  s.checked ? "text-text" : "text-dim line-through"
                }`}
              >
                {s.text}
              </span>
            </button>
          ))}
          <div className="flex gap-2 px-3 py-3 border-t border-stroke">
            <button
              onClick={() => setSuggestions(null)}
              className="flex-1 h-[38px] rounded-xl text-[13px] font-medium text-sub bg-card2 active:opacity-70"
            >
              Отмена
            </button>
            <button
              onClick={handleConfirmSuggestions}
              disabled={
                !suggestions.some((s) => s.checked) || confirmingSuggestions
              }
              className="flex-1 h-[38px] rounded-xl text-[13px] font-semibold text-white bg-red active:opacity-70 disabled:opacity-50"
            >
              {confirmingSuggestions ? "Добавляю…" : "Добавить выбранные"}
            </button>
          </div>
        </div>
      )}

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
                    onDragStart={() => setDraggingSubtask(true)}
                    onDragEnd={handleSubtaskDragEnd}
                    onDragCancel={() => setDraggingSubtask(false)}
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

      {/* ── Срок / Проект / Приоритет — mockup .card (screen 11) ── */}
      <div className="mb-4">
        <Card>
          <DueDateField value={dueDate} onChange={setDueDate} />
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
                    className="w-full flex items-center gap-3 py-3 px-[14px] text-left active:bg-white/[0.04] transition-colors"
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
                  <div className="px-[14px] py-3 text-[13px] text-dim">
                    Проектов пока нет
                  </div>
                )}
              </div>
            )}
          </div>
          <PriorityField value={priority} onChange={setPriority} />
        </Card>
      </div>

      {/* ── Assignee (tappable → picker) ── */}
      <div className="text-[13px] text-sub font-semibold mb-2">Назначить</div>
      <div className="bg-card rounded-[14px] overflow-hidden mb-4">
        {showAssigneePicker ? (
          <>
            {agents.map((u) => (
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
                  {u.role === "owner" ? "Владелец" : "Агент"}
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
                const u = agents.find((us) => us.id === assignee);
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
                      {u.role === "owner" ? "Владелец" : "Агент"}
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

      {/* ── Labels — mockup .tags-row ── */}
      <div className="text-[13px] text-sub font-semibold mb-2">Метки</div>
      <div className="mb-4">
        <LabelsField
          labels={labels}
          selectedIds={selectedLabelIds}
          onToggle={toggleLabel}
          onCreate={handleCreateLabel}
        />
        <ErrorBanner
          error={createLabel.error}
          fallback="Не удалось создать метку. Проверьте соединение."
          variant="block"
          className="mt-2"
        />
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
