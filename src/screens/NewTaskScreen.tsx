import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useProjects } from "../api/projects";
import { useLabels, useCreateLabel } from "../api/labels";
import { useAgents } from "../api/agents";
import { useCreateTask } from "../api/tasks";
import { createSubtaskRequest } from "../api/subtasks";
import { Icon, Avatar } from "../components/UI";
import { todayStr } from "../lib/date";

const MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];
const PRIORITIES = [
  { key: 1, label: "P1", color: "#E44332" },
  { key: 2, label: "P2", color: "#FF9A14" },
  { key: 3, label: "P3", color: "#4A9FD8" },
  { key: 4, label: "P4", color: "#A6A6A6" },
];

function miniCal(year: number, month: number) {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
}

export function NewTaskScreen() {
  const navigate = useNavigate();
  const { data: agents = [] } = useAgents();
  const { data: projects = [] } = useProjects();
  const { data: labels = [] } = useLabels();
  const createTask = useCreateTask();
  const createLabel = useCreateLabel();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [assignee, setAssignee] = useState<string | undefined>();
  const [priority, setPriority] = useState(1);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [newSub, setNewSub] = useState("");
  const [saving, setSaving] = useState(false);

  const today = todayStr();
  const todayDate = new Date(today + "T00:00:00");

  // Date picker
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [calYear, setCalYear] = useState(todayDate.getFullYear());
  const [calMonth, setCalMonth] = useState(todayDate.getMonth());
  const [dueDate, setDueDate] = useState(today);

  // Project picker — default to the current user's first project, not a
  // hardcoded id (which wouldn't belong to every user).
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const effectiveProjectId = projectId ?? projects[0]?.id;

  // Priority picker
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);

  // Assignee picker
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);

  const currentProject = projects.find((p) => p.id === effectiveProjectId);
  const dueDateObj = dueDate ? new Date(dueDate + "T00:00:00") : null;

  const toggleLabel = (id: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
    );
  };

  const addSubtask = () => {
    if (newSub.trim()) {
      setSubtasks([...subtasks, newSub.trim()]);
      setNewSub("");
    }
  };

  const handleCreateLabel = async () => {
    const name = window.prompt("Название метки:");
    if (!name?.trim()) return;
    const label = await createLabel.mutateAsync({ name: name.trim() });
    setSelectedLabelIds((prev) => [...prev, label.id]);
  };

  const handleSave = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const { task } = await createTask.mutateAsync({
        title: title.trim(),
        description: desc.trim() || undefined,
        due_date: dueDate || undefined,
        project_id: effectiveProjectId,
        priority,
        assignee_id: assignee,
        label_ids: selectedLabelIds,
      });

      // The create-task endpoint has no bulk-subtask param — create them
      // one by one against the dedicated subtask endpoint.
      if (subtasks.length > 0) {
        for (const s of subtasks) {
          // eslint-disable-next-line no-await-in-loop
          await createSubtaskRequest(task.id, s);
        }
        qc.invalidateQueries({ queryKey: ["tasks"] });
      }

      navigate("/inbox");
    } finally {
      setSaving(false);
    }
  };

  const calCells = miniCal(calYear, calMonth);

  return (
    <div className="px-4 pb-4 min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between h-[48px] mb-2">
        <button
          onClick={() => navigate(-1)}
          className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center active:scale-95"
        >
          <Icon name="x" size={18} />
        </button>
        <h2 className="text-[17px] font-semibold">Новая задача</h2>
        <button
          onClick={handleSave}
          disabled={!title.trim() || saving}
          className="text-[16px] font-semibold text-red active:opacity-70 disabled:opacity-50"
        >
          {saving ? "Сохранение…" : "Готово"}
        </button>
      </div>

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
        className="w-full bg-transparent text-[15px] text-sub placeholder:text-dim resize-none outline-none mb-4 min-h-[40px]"
        rows={2}
      />

      <div className="h-px bg-stroke mb-2" />

      {/* ── Due date (tappable → inline calendar) ── */}
      <button
        onClick={() => {
          setShowDatePicker(!showDatePicker);
          setShowProjectPicker(false);
          setShowPriorityPicker(false);
          setShowAssigneePicker(false);
        }}
        className="w-full flex items-center gap-3 py-3 text-left active:bg-card/50 rounded-lg transition-colors"
      >
        <Icon name="calendarSmall" size={18} className="text-dim" />
        <span className="text-[15px] text-sub flex-1">Срок</span>
        <span className="text-[14px] text-red">
          {dueDateObj
            ? `${dueDateObj.getDate()} ${MONTHS[dueDateObj.getMonth()]}`
            : "Не установлен"}
        </span>
        <Icon
          name={showDatePicker ? "chevronDown" : "chevron"}
          size={16}
          className="text-dim"
        />
      </button>

      {showDatePicker && (
        <div className="bg-card rounded-2xl p-3 mb-3 animate-in">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() =>
                calMonth === 0
                  ? (setCalMonth(11), setCalYear(calYear - 1))
                  : setCalMonth(calMonth - 1)
              }
              className="p-1"
            >
              <Icon name="chevronLeft" size={16} className="text-sub" />
            </button>
            <span className="text-[13px] font-semibold">
              {MONTHS[calMonth]} {calYear}
            </span>
            <button
              onClick={() =>
                calMonth === 11
                  ? (setCalMonth(0), setCalYear(calYear + 1))
                  : setCalMonth(calMonth + 1)
              }
              className="p-1"
            >
              <Icon name="chevron" size={16} className="text-sub" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0">
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "СБ"].map((d) => (
              <div key={d} className="text-center text-[10px] text-dim py-1">
                {d}
              </div>
            ))}
            {calCells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const ds = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const selected = ds === dueDate;
              return (
                <button
                  key={i}
                  onClick={() => {
                    setDueDate(ds);
                    setShowDatePicker(false);
                  }}
                  className={`h-[32px] text-[13px] rounded-full transition-all ${
                    selected
                      ? "bg-red text-white font-semibold"
                      : "text-text active:bg-card2"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => {
              setDueDate("");
              setShowDatePicker(false);
            }}
            className="w-full text-center text-[13px] text-sub py-2 mt-1"
          >
            Убрать дату
          </button>
        </div>
      )}

      <div className="h-px bg-stroke mx-1" />

      {/* ── Project (tappable → picker) ── */}
      <button
        onClick={() => {
          setShowProjectPicker(!showProjectPicker);
          setShowDatePicker(false);
          setShowPriorityPicker(false);
          setShowAssigneePicker(false);
        }}
        className="w-full flex items-center gap-3 py-3 text-left active:bg-card/50 rounded-lg transition-colors"
      >
        <Icon name="hash" size={18} className="text-dim" />
        <span className="text-[15px] text-sub flex-1">Проект</span>
        <span className="text-[14px] text-text">
          {currentProject?.name || "Без проекта"}
        </span>
        <Icon
          name={showProjectPicker ? "chevronDown" : "chevron"}
          size={16}
          className="text-dim"
        />
      </button>

      {showProjectPicker && (
        <div className="bg-card rounded-2xl overflow-hidden mb-3 animate-in">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setProjectId(p.id);
                setShowProjectPicker(false);
              }}
              className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-card2 transition-colors"
            >
              <Icon name="hash" size={16} style={{ color: p.color }} />
              <span className="text-[14px] text-text flex-1">{p.name}</span>
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

      <div className="h-px bg-stroke mx-1" />

      {/* ── Priority (tappable → picker) ── */}
      <button
        onClick={() => {
          setShowPriorityPicker(!showPriorityPicker);
          setShowDatePicker(false);
          setShowProjectPicker(false);
          setShowAssigneePicker(false);
        }}
        className="w-full flex items-center gap-3 py-3 text-left active:bg-card/50 rounded-lg transition-colors"
      >
        <Icon name="flag" size={18} className="text-dim" />
        <span className="text-[15px] text-sub flex-1">Приоритет</span>
        <span
          className="text-[12px] font-semibold text-white px-2 py-0.5 rounded"
          style={{
            backgroundColor: PRIORITIES.find((p) => p.key === priority)?.color,
          }}
        >
          {PRIORITIES.find((p) => p.key === priority)?.label}
        </span>
        <Icon
          name={showPriorityPicker ? "chevronDown" : "chevron"}
          size={16}
          className="text-dim"
        />
      </button>

      {showPriorityPicker && (
        <div className="bg-card rounded-2xl overflow-hidden mb-3 animate-in">
          {PRIORITIES.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setPriority(p.key);
                setShowPriorityPicker(false);
              }}
              className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-card2 transition-colors"
            >
              <span
                className="w-[24px] h-[24px] rounded-full flex items-center justify-center text-[11px] font-bold text-white"
                style={{ backgroundColor: p.color }}
              >
                {p.label}
              </span>
              <span className="text-[14px] text-text">
                {p.key === 1
                  ? "Срочный"
                  : p.key === 2
                    ? "Высокий"
                    : p.key === 3
                      ? "Средний"
                      : "Низкий"}
              </span>
              {p.key === priority && (
                <Icon name="check" size={16} className="text-red ml-auto" />
              )}
            </button>
          ))}
        </div>
      )}

      <div className="h-px bg-stroke mb-2 mt-1" />

      {/* ── Assignee (tappable → picker) ── */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">
        Назначить
      </div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
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

      {/* ── Labels (tappable pills) ── */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Метки</div>
      <div className="flex flex-wrap gap-2 mb-4">
        {labels.map((l) => {
          const active = selectedLabelIds.includes(l.id);
          return (
            <button
              key={l.id}
              onClick={() => toggleLabel(l.id)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] transition-all active:scale-95"
              style={{
                backgroundColor: active ? l.color + "35" : "#242424",
                color: active ? l.color : "#A6A6A6",
                borderWidth: 1,
                borderColor: active ? l.color + "50" : "transparent",
              }}
            >
              <Icon name="tag" size={11} />
              {l.name}
              {active && <Icon name="check" size={12} />}
            </button>
          );
        })}
        <button
          onClick={handleCreateLabel}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] text-sub bg-card active:scale-95"
        >
          + новая
        </button>
      </div>

      <div className="h-px bg-stroke mb-2" />

      {/* ── Subtasks ── */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">
        Подзадачи
      </div>
      {subtasks.map((s, i) => (
        <div key={i} className="flex items-center gap-3 py-2.5 px-1">
          <div className="w-[18px] h-[18px] rounded-full border-2 border-dim shrink-0" />
          <span className="text-[14px] text-text flex-1">{s}</span>
          <button
            onClick={() => setSubtasks(subtasks.filter((_, j) => j !== i))}
            className="p-1"
          >
            <Icon name="x" size={14} className="text-dim" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3 py-2.5 px-1">
        <div className="w-[18px] h-[18px] rounded-full border-2 border-dim shrink-0" />
        <input
          value={newSub}
          onChange={(e) => setNewSub(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSubtask()}
          placeholder="Добавить подзадачу..."
          className="flex-1 bg-transparent text-[14px] text-dim placeholder:text-dim outline-none"
        />
        {newSub.trim() && (
          <button onClick={addSubtask} className="p-1">
            <Icon name="check" size={16} className="text-red" />
          </button>
        )}
      </div>
    </div>
  );
}
