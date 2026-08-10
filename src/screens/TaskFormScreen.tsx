// Единая форма задачи — создание И редактирование одним и тем же экраном
// (owner 2026-08-10: «точно такой же интерфейс должен открываться при
// редактировании, а сейчас ничего такого не открывается» — переиспользуем
// форму, а не изобретаем отдельное подменю). Разница только в источнике
// исходных значений (пусто vs. загруженная задача) и в способе сохранения
// (POST один раз vs. PATCH одним пакетом по кнопке «Готово»). Подзадачи —
// исключение: у существующей задачи они уже персистентны, поэтому их
// CRUD идёт через живой API сразу, а не копится в локальном стейте.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useProjects } from "../api/projects";
import { useLabels, useCreateLabel } from "../api/labels";
import { useAgents } from "../api/agents";
import { useCreateTask, useTask, useUpdateTask } from "../api/tasks";
import {
  createSubtaskRequest,
  useCreateSubtask,
  useDeleteSubtask,
  useUpdateSubtask,
} from "../api/subtasks";
import { Icon, Avatar, ScreenHeader } from "../components/UI";
import {
  Card,
  FieldRow,
  DueDateField,
  PriorityField,
  LabelsField,
  SubtaskRow,
  AddSubtaskRow,
} from "../components/TaskFields";
import { todayStr } from "../lib/date";
import type { UpdateTaskInput } from "../api/tasks";

export function TaskFormScreen() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: agents = [] } = useAgents();
  const { data: projects = [] } = useProjects();
  const { data: labels = [] } = useLabels();
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

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [assignee, setAssignee] = useState<string | undefined>();
  const [priority, setPriority] = useState(1);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  // Create mode only — subtasks of a not-yet-created task have no id to
  // CRUD against, so they're held locally and posted right after the task
  // itself is created (see handleSave).
  const [localSubtasks, setLocalSubtasks] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<string | null>(todayStr());
  // undefined = "not touched yet" (create mode falls back to the user's
  // first project); null = "explicitly no project" (a valid state only
  // reachable in edit mode, for a task that lives in Inbox).
  const [projectId, setProjectId] = useState<string | null | undefined>(
    undefined,
  );
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [saving, setSaving] = useState(false);
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

  const effectiveProjectId = isEdit
    ? (projectId ?? null)
    : (projectId ?? projects[0]?.id);
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

  const handleSave = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      if (isEdit && id) {
        const patch = buildDirtyPatch();
        if (Object.keys(patch).length > 0) {
          await updateTask.mutateAsync({ id, ...patch });
        }
        navigate(`/task/${id}`);
      } else {
        const { task } = await createTask.mutateAsync({
          title: title.trim(),
          description: desc.trim() || undefined,
          due_date: dueDate || undefined,
          project_id: effectiveProjectId ?? undefined,
          priority,
          assignee_id: assignee,
          label_ids: selectedLabelIds,
        });

        // The create-task endpoint has no bulk-subtask param — create them
        // one by one against the dedicated subtask endpoint.
        if (localSubtasks.length > 0) {
          for (const s of localSubtasks) {
            // eslint-disable-next-line no-await-in-loop
            await createSubtaskRequest(task.id, s);
          }
          qc.invalidateQueries({ queryKey: ["tasks"] });
        }

        navigate("/inbox");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 pb-4 min-h-full">
      <ScreenHeader
        variant="compact"
        leading={
          <button
            onClick={() => navigate(-1)}
            className="w-[44px] h-[44px] rounded-full bg-card2 flex items-center justify-center active:scale-95"
          >
            <Icon name="x" size={18} />
          </button>
        }
        title={isEdit ? "Изменить задачу" : "Новая задача"}
        actions={
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
            className="text-[16px] font-semibold text-red active:opacity-70 disabled:opacity-50"
          >
            {saving ? "Сохранение…" : "Готово"}
          </button>
        }
      />

      {/* Title */}
      <textarea
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Название задачи"
        className="w-full bg-transparent text-[20px] font-medium text-text placeholder:text-dim resize-none outline-none mb-2 min-h-[32px]"
        rows={1}
      />

      {/* Description */}
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Описание"
        className="w-full bg-transparent text-[16px] text-sub placeholder:text-dim resize-none outline-none mb-4 min-h-[40px]"
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
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Подзадачи
      </div>
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
      </div>
    </div>
  );
}
