// ═══════════ LABELS SCREEN — full CRUD for the owner's labels ═══════════
// The server has always supported rename/recolor/delete on labels
// (PATCH/DELETE /api/labels/:id) — this screen is the first client UI for
// any of that. Modeled closely on ProjectsScreen (same row-becomes-inline-
// edit-form shape, same color-swatch picker), since labels and projects
// share the same "named, colored, owned" shape server-side.
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
} from "../api/labels";
import {
  Icon,
  ScreenHeader,
  ErrorBanner,
  Loading,
  Button,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { taskWord } from "../lib/pluralize";
import type { ApiLabel, ApiTask } from "../api/types";

// Not inventing new colors — this is the same 7-swatch set ProjectsScreen/
// OverviewScreen already offer for projects (project & label rows are the
// same "named + colored" shape server-side), which itself opens with the
// server's own label default (#FF7A8A) and project default (#4A9FD8),
// plus the four priority colors from lib/priority.ts (#E44332/#FF9A14/
// #4A9FD8/#A6A6A6) so a label can always be made to match a priority dot.
const LABEL_COLORS = [
  "#FF7A8A",
  "#4A9FD8",
  "#A78BFA",
  "#E44332",
  "#FF9A14",
  "#8FBF9F",
  "#35B8A3",
];

function ColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-label={`Цвет ${c}`}
          className="w-[26px] h-[26px] rounded-full shrink-0 tap-scale"
          style={{
            backgroundColor: c,
            outline: value === c ? "2px solid white" : "none",
            outlineOffset: 2,
          }}
        />
      ))}
    </div>
  );
}

// One row = one component instance with its own edit state, its own
// useUpdateLabel mutation and its own useGuardedCallback — tapping "Save"
// twice fast on row A can't race with row B (see ProjectsScreen's
// ProjectRow, same reasoning).
function LabelRow({
  label,
  taskCount,
  onRequestDelete,
}: {
  label: ApiLabel;
  taskCount: number | null;
  onRequestDelete: (label: ApiLabel) => void;
}) {
  const navigate = useNavigate();
  const updateLabel = useUpdateLabel();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);

  const startEdit = () => {
    setName(label.name);
    setColor(label.color);
    updateLabel.reset();
    setEditing(true);
  };

  const cancelEdit = () => {
    updateLabel.reset();
    setEditing(false);
  };

  const handleSave = useGuardedCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Always send both fields — see UpdateLabelInput's note: the server
    // 400s a PATCH with no `name`, even for a color-only recolor.
    await updateLabel.mutateAsync({ id: label.id, name: trimmed, color });
    setEditing(false);
  });

  if (editing) {
    return (
      <div className="bg-card rounded-xl p-4 mb-[2px]">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название метки"
          className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
        />
        <ColorSwatches value={color} onChange={setColor} />
        <ErrorBanner
          error={updateLabel.error}
          fallback="Не удалось сохранить метку"
          variant="block"
          className="mb-3"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelEdit}
            className="flex-1 h-11 rounded-xl bg-card2 text-[14px] text-sub font-semibold tap-row"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || updateLabel.isPending}
            className="flex-1 h-11 rounded-xl bg-red text-[14px] text-white font-semibold disabled:opacity-50 tap-fade"
          >
            {updateLabel.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex items-center bg-card rounded-xl mb-[2px]">
      <button
        onClick={() => navigate(`/labels/${label.id}`)}
        className="tap-row rounded-l-xl flex-1 min-w-0 flex items-center gap-3 py-3 pl-4 pr-1 text-left"
      >
        <div
          className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: label.color + "20" }}
        >
          <Icon name="tag" size={16} style={{ color: label.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] text-text truncate">{label.name}</div>
          {taskCount !== null && (
            <div className="text-[12px] text-sub">
              {taskCount === 0
                ? "Нет задач"
                : `${taskCount} ${taskWord(taskCount)}`}
            </div>
          )}
        </div>
      </button>
      <button
        onClick={startEdit}
        aria-label="Изменить метку"
        className="w-[44px] h-[44px] flex items-center justify-center shrink-0 text-dim tap-row"
      >
        <Icon name="edit" size={16} />
      </button>
      <button
        onClick={() => onRequestDelete(label)}
        aria-label="Удалить метку"
        className="w-[44px] h-[44px] mr-1 flex items-center justify-center shrink-0 text-dim tap-row"
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
}

export function LabelsScreen() {
  const { data: labels = [], isLoading, isError, error } = useLabels();
  const createLabel = useCreateLabel();
  const deleteLabel = useDeleteLabel();
  const { confirm, dialog } = useDialog();
  const qc = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createLabel.mutateAsync({ name: name.trim(), color });
    setName("");
    setColor(LABEL_COLORS[0]);
    setShowCreate(false);
  });

  // Per-label task counts, read straight off whatever ["tasks"] already
  // holds in the query cache — no dedicated fetch. If nothing has loaded
  // tasks yet this session (fresh navigation straight to /labels), the
  // cache is empty and every count is simply omitted rather than firing a
  // new request just to fill in a number.
  const taskCounts = useMemo(() => {
    const tasks = qc.getQueryData<ApiTask[]>(["tasks"]);
    if (!tasks) return null;
    const counts = new Map<string, number>();
    for (const t of tasks) {
      for (const l of t.labels ?? []) {
        counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
      }
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // a one-shot read of whatever's cached at mount, not a live subscription.
  }, [qc, labels]);

  const handleDelete = async (label: ApiLabel) => {
    // taskCounts is only populated when ["tasks"] happens to already be in
    // the query cache (see the comment above) — it can be `null` even when
    // the label genuinely IS attached to tasks (e.g. a fresh, direct
    // navigation to /labels never having loaded any task list this
    // session). The warning that deleting a label detaches it from every
    // task must not depend on that cache being warm — only the exact
    // count is allowed to vary with what's known.
    const count = taskCounts?.get(label.id);
    const ok = await confirm({
      title: `Удалить метку «${label.name}»?`,
      description:
        count === undefined
          ? "Она снимется со всех задач, которым сейчас назначена, если такие есть. Сами задачи не удалятся — только метка на них. Действие нельзя отменить."
          : count > 0
            ? `Она снимется со всех задач, которым сейчас назначена (${count} ${taskWord(count)}). Сами задачи не удалятся — только метка на них.`
            : "Сейчас ею не помечена ни одна задача. Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteLabel.mutateAsync(label.id);
    } catch (err) {
      setDeleteError(err);
    }
  };

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader
        variant="compact"
        title="Метки"
      />

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-card rounded-2xl p-4 mb-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название метки"
            className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
          />
          <ColorSwatches value={color} onChange={setColor} />
          <ErrorBanner
            error={createLabel.error}
            fallback="Не удалось создать метку"
            variant="block"
            className="mb-3"
          />
          <button
            type="submit"
            disabled={!name.trim() || createLabel.isPending}
            className="w-full h-12 bg-red rounded-xl text-[14px] font-semibold text-white disabled:opacity-50 tap-fade"
          >
            {createLabel.isPending ? "Создаём…" : "Создать"}
          </button>
        </form>
      )}

      {isLoading && <Loading />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить метки"
        variant="inline"
        className="mb-2"
      />
      {deleteError !== null && (
        <ErrorBanner
          error={deleteError}
          fallback="Не удалось удалить метку"
          variant="block"
          className="mb-2"
        />
      )}

      {!isLoading && !isError && labels.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center text-center pt-16 px-4">
          <div className="w-[64px] h-[64px] rounded-full bg-card flex items-center justify-center mb-4">
            <Icon name="tag" size={28} className="text-dim" />
          </div>
          <h3 className="text-[17px] font-semibold mb-1">Меток пока нет</h3>
          <p className="text-[14px] text-sub leading-relaxed mb-6 max-w-[280px]">
            Метки помогают группировать задачи по-своему — независимо от
            проектов и сроков. Создайте первую, а состав всегда можно поменять
            позже.
          </p>
          <Button
            variant="primary"
            onClick={() => setShowCreate(true)}
            className="w-auto px-6"
          >
            <Icon name="plus" size={18} />
            Создать метку
          </Button>
        </div>
      ) : (
        <div className="space-y-[2px]">
          {labels.map((l) => (
            <LabelRow
              key={l.id}
              label={l}
              taskCount={taskCounts?.get(l.id) ?? (taskCounts ? 0 : null)}
              onRequestDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {!showCreate && labels.length > 0 && (
        <button
          onClick={() => setShowCreate(true)}
          className="w-full flex items-center gap-3 py-3 px-4 mt-4 border border-dashed border-stroke rounded-xl tap-row"
        >
          <Icon name="plus" size={18} className="text-dim" />
          <span className="text-[14px] text-sub">Создать метку</span>
        </button>
      )}
    </div>
  );
}
