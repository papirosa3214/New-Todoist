// ═══════════ TASKS FROM TEXT SHEET (Дневник → Проекты, AI-мост) ═══════════
// Владелец 25.08.2026: «ии мост в проекты» — AI находит в тексте дневника
// конкретные дела (extract-tasks, server/src/routes/ai.ts), но НИЧЕГО не
// создаёт сам, только предлагает. Здесь — тот же принцип подтверждения
// ПЕРЕД сохранением, что и у структурирования задачи в TaskFormScreen:
// строки редактируемы (только заголовок, v1 — не городим полную форму на
// каждую строку), с чек-боксом «включить/выключить», плюс выбор — в какой
// проект их положить: существующий (радио-список, приём из
// TaskFilterSheet.tsx) или создать новый прямо здесь.
import { useEffect, useState } from "react";
import { Icon, SheetHandle, ErrorBanner } from "./UI";
import { useBottomSheet } from "../lib/useBottomSheet";
import { useProjects, useCreateProject } from "../api/projects";
import { useCreateTask } from "../api/tasks";
import type { ExtractedTask } from "../api/ai";

interface Row {
  include: boolean;
  title: string;
  source: ExtractedTask;
}

// Строит ключ из заголовков задач. Раньше эта логика стояла прямо в render
// (`tasks.map(...).join("|")` с setState-during-render) — в React 18+
// формально работает, но ловит undefined.tasks с TypeError без шанса
// отреагировать; пользователь видит «белый экран», а в логах ничего.
// Карточка 70697681: «Собрать задачи» падает — на сервере пусто,
// падение случается на клиенте при странной форме ответа. Теперь
// useEffect: tasks=undefined → пустой массив, rows не сбрасываются
// зря при переходе между notes, ключ — стабильный.
function tasksKeyOf(tasks: ExtractedTask[] | undefined | null): string {
  if (!tasks) return "";
  return tasks.map((t) => t?.title ?? "").join("|");
}

export function TasksFromTextSheet({
  open,
  onClose,
  tasks,
}: {
  open: boolean;
  onClose: () => void;
  tasks: ExtractedTask[];
}) {
  const sheet = useBottomSheet({ open, onClose });
  const { data: projects = [] } = useProjects();
  const createProject = useCreateProject();
  const createTask = useCreateTask();

  const [rows, setRows] = useState<Row[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [creatingNew, setCreatingNew] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // При каждом открытии с новым набором задач пересобираем строки.
  // useEffect вместо setState-during-render: ошибки в render-phase
  // ломают всё дерево без возможности показать баннер, в useEffect —
  // поймает ближайший ErrorBoundary (см. ErrorBoundary.tsx).
  const tasksKey = tasksKeyOf(tasks);
  useEffect(() => {
    if (!open) return;
    if (!Array.isArray(tasks)) {
      setRows([]);
      setError(null);
      return;
    }
    setRows(tasks.map((t) => ({ include: true, title: t.title, source: t })));
    setSelectedProjectId(null);
    setCreatingNew(false);
    setNewProjectName("");
    setError(null);
    // tasksKey закрывает «та же дата не откроет шторку дважды подряд» —
    // меняется только при смене состава, не на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tasksKey]);

  if (!sheet.mounted) return null;

  const includedCount = rows.filter((r) => r.include).length;
  const canConfirm =
    includedCount > 0 &&
    (creatingNew ? newProjectName.trim().length > 0 : !!selectedProjectId) &&
    !busy;

  const toggleInclude = (idx: number) =>
    setRows((rs) =>
      rs.map((r, i) => (i === idx ? { ...r, include: !r.include } : r)),
    );
  const updateTitle = (idx: number, title: string) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, title } : r)));

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      let projectId = selectedProjectId;
      if (creatingNew) {
        const created = await createProject.mutateAsync({
          name: newProjectName.trim(),
        });
        projectId = created.id;
      }
      const included = rows.filter((r) => r.include && r.title.trim());
      for (const row of included) {
        await createTask.mutateAsync({
          title: row.title.trim(),
          description: row.source.description || undefined,
          due_date: row.source.due_date || undefined,
          priority: row.source.priority,
          project_id: projectId || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Не удалось создать задачи"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center disabled:opacity-40"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          <h3 className="text-[17px] font-semibold text-text">
            Задачи из дневника
          </h3>
          <div className="w-11" />
        </div>

        {rows.length === 0 && (
          <div className="px-1 py-3 text-[13px] text-dim">
            AI не нашёл в тексте конкретных задач
          </div>
        )}

        <div className="flex flex-col gap-1.5 pb-3">
          {rows.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleInclude(idx)}
                disabled={busy}
                aria-label={
                  row.include ? "Убрать из списка" : "Добавить в список"
                }
                className="tap-scale shrink-0 w-7 h-7 flex items-center justify-center"
              >
                <Icon
                  name={row.include ? "check" : "circle"}
                  size={18}
                  className={row.include ? "text-red" : "text-dim"}
                />
              </button>
              <input
                value={row.title}
                onChange={(e) => updateTitle(idx, e.target.value)}
                disabled={!row.include || busy}
                className="flex-1 bg-card2 rounded-lg px-3 py-2 text-[14px] text-text placeholder:text-dim outline-none disabled:opacity-40"
              />
            </div>
          ))}
        </div>

        {rows.length > 0 && (
          <>
            <div className="text-[12px] text-dim uppercase tracking-wide pt-2 pb-1.5 px-1">
              Куда добавить
            </div>
            <div className="border-t border-stroke">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelectedProjectId(p.id);
                    setCreatingNew(false);
                  }}
                  className="tap-row w-full flex items-center gap-3 py-2.5 px-1 text-left"
                >
                  <Icon name="hash" size={16} style={{ color: p.color }} />
                  <span className="text-[14px] text-text flex-1 truncate">
                    {p.name}
                  </span>
                  {!creatingNew && selectedProjectId === p.id && (
                    <Icon name="check" size={16} className="text-red" />
                  )}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreatingNew(true);
                  setSelectedProjectId(null);
                }}
                className="tap-row w-full flex items-center gap-3 py-2.5 px-1 text-left"
              >
                <Icon name="plus" size={16} className="text-sub" />
                <span className="text-[14px] text-text flex-1">
                  Новый проект
                </span>
                {creatingNew && (
                  <Icon name="check" size={16} className="text-red" />
                )}
              </button>
              {creatingNew && (
                <input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Название проекта"
                  disabled={busy}
                  className="w-full bg-card2 rounded-lg px-3 py-2 mb-2 text-[14px] text-text placeholder:text-dim outline-none"
                />
              )}
            </div>
          </>
        )}

        <ErrorBanner
          error={error}
          fallback="Не удалось создать задачи"
          className="mt-3"
        />

        {rows.length > 0 && (
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="tap-scale w-full h-12 rounded-xl bg-red text-[15px] font-semibold text-white disabled:opacity-40 mt-3"
          >
            {busy
              ? "Создаю…"
              : `Создать ${includedCount ? `(${includedCount})` : ""}`}
          </button>
        )}
      </div>
    </div>
  );
}
