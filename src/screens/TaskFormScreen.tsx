// Единая форма задачи — создание И редактирование одним и тем же экраном
// (owner 2026-08-10: «точно такой же интерфейс должен открываться при
// редактировании, а сейчас ничего такого не открывается» — переиспользуем
// форму, а не изобретаем отдельное подменю). Разница только в источнике
// исходных значений (пусто vs. загруженная задача) и в способе сохранения
// (POST один раз vs. PATCH одним пакетом по кнопке «Готово»). Подзадачи —
// исключение: у существующей задачи они уже персистентны, поэтому их
// CRUD идёт через живой API сразу, а не копится в локальном стейте.
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { findProjectByName, parseDictation } from "../lib/dictationParser";
import type { UpdateTaskInput } from "../api/tasks";

export function TaskFormScreen() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

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
  const [assignee, setAssignee] = useState<string | undefined>();
  const [priority, setPriority] = useState(1);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  // Create mode only — subtasks of a not-yet-created task have no id to
  // CRUD against, so they're held locally and sent as part of the atomic
  // POST /api/tasks `subtasks` param (see handleSave).
  const [localSubtasks, setLocalSubtasks] = useState<string[]>([]);
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
      navigate(`/task/${id}`);
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
        title={isEdit ? "Изменить задачу" : "Новая задача"}
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

      {/* Title */}
      <textarea
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={applyDictationParse}
        placeholder="Название задачи"
        className="block w-full bg-transparent text-[20px] font-medium text-text placeholder:text-dim resize-none outline-none mb-2 min-h-[32px]"
        rows={1}
      />

      {/* Description */}
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Описание"
        className="block w-full bg-transparent text-[16px] text-sub placeholder:text-dim resize-none outline-none mb-4 min-h-[40px]"
        rows={2}
      />

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

      {/* ── Subtasks — moved up, right under the main card ── */}
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-[13px] text-sub font-semibold">Подзадачи</span>
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

      <div className="mb-4">
        <Card>
          {/* Card only draws a divider between DIRECT children (see its
              own Children.toArray) — a single wrapping Fragment here would
              collapse the whole list into one child and lose every row
              separator, so each row/array must be spread as a sibling. */}
          {isEdit
            ? [
                ...(existingTask?.subtasks || []).map((st) => (
                  <SubtaskRow
                    key={st.id}
                    title={st.title}
                    done={st.done}
                    onToggle={() =>
                      updateSubtask.mutate({ id: st.id, done: !st.done })
                    }
                    onRename={(t) =>
                      updateSubtask.mutate({ id: st.id, title: t })
                    }
                    onDelete={() => deleteSubtask.mutate(st.id)}
                  />
                )),
                <AddSubtaskRow
                  key="add"
                  onAdd={(t) => createSubtask.mutate(t)}
                />,
              ]
            : [
                ...localSubtasks.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-[14px] py-[12px]"
                  >
                    <div className="w-[18px] h-[18px] rounded-full border-2 border-dim shrink-0" />
                    <span className="text-[14px] text-text flex-1">{s}</span>
                    <button
                      onClick={() =>
                        setLocalSubtasks(
                          localSubtasks.filter((_, j) => j !== i),
                        )
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
                />,
              ]}
        </Card>
        <ErrorBanner
          error={
            createSubtask.error ?? updateSubtask.error ?? deleteSubtask.error
          }
          fallback="Не удалось изменить подзадачи. Проверьте соединение."
          variant="block"
          className="mt-2"
        />
      </div>

      {/* ── Assignee (tappable → picker) ── */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Назначить
      </div>
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
                  size={32}
                />
                <div className="flex-1">
                  <div className="text-[14px] text-text">{u.name}</div>
                </div>
                <span className="text-[12px] text-sub bg-card2 px-2 py-0.5 rounded">
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
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Метки</div>
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
    </div>
  );
}
