import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useArchivedProjects,
  useRestoreProject,
  usePurgeProject,
  type ArchivedProject,
} from "../api/projects";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { taskWord } from "../lib/pluralize";

// Экран Архива (карточка a1be7d63…). Сюда попадают проекты, удалённые из
// «Проектов»: данные целы, но в обычных местах их не видно. Владелец может
// вернуть проект («Вернуть») или стереть навсегда («Удалить навсегда»), при
// этом в подтверждении перечислены последствия числами.
function ArchivedRow({
  project,
  onRestore,
  onPurge,
  busy,
}: {
  project: ArchivedProject;
  onRestore: (p: ArchivedProject) => void;
  onPurge: (p: ArchivedProject) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl bg-card p-4 mb-[2px]">
      <div className="flex items-center gap-3">
        <div
          className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: project.color + "20" }}
        >
          <Icon name="archive" size={16} style={{ color: project.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="tf-body text-text truncate">{project.name}</div>
          <div className="tf-meta text-sub">
            {project.task_count} {taskWord(project.task_count)} ·{" "}
            {project.docs_count ?? 0} док.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onRestore(project)}
          className="tf-row flex-1 h-10 rounded-xl bg-card2 text-text tap-row disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Icon name="restore" size={16} />
          Вернуть
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onPurge(project)}
          className="tf-row flex-1 h-10 rounded-xl bg-red text-white tap-fade disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Icon name="trash" size={16} />
          Удалить навсегда
        </button>
      </div>
    </div>
  );
}

export function ProjectArchiveScreen() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading, isError, error } =
    useArchivedProjects();
  const restoreProject = useRestoreProject();
  const purgeProject = usePurgeProject();
  const { confirm, dialog } = useDialog();
  const [actionError, setActionError] = useState<unknown>(null);

  const handleRestore = useGuardedCallback(async (project: ArchivedProject) => {
    const ok = await confirm({
      title: `Вернуть проект «${project.name}»?`,
      description:
        "Проект снова появится в «Проектах» вместе со своими задачами. Чаты проекта останутся закрытыми — откройте их отдельно, если нужно.",
      confirmLabel: "Вернуть",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await restoreProject.mutateAsync(project.id);
    } catch (err) {
      setActionError(err);
    }
  });

  const handlePurge = useGuardedCallback(async (project: ArchivedProject) => {
    const tasks = project.task_count ?? 0;
    const docs = project.docs_count ?? 0;
    const chats = project.chat_count ?? 0;
    const memories = project.memory_count ?? 0;
    const ok = await confirm({
      title: `Удалить проект «${project.name}» навсегда?`,
      description:
        `Будут уничтожены: ${tasks} ${taskWord(tasks)}, ${chats} чат(ов), ${memories} записей памяти. ` +
        (docs > 0
          ? `Документы (${docs} док.) останутся в заметках — можно удалить позже вручную. `
          : "") +
        "Это действие нельзя отменить.",
      confirmLabel: "Удалить навсегда",
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      await purgeProject.mutateAsync({ id: project.id });
    } catch (err) {
      setActionError(err);
    }
  });

  const busy =
    restoreProject.isPending || purgeProject.isPending;

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader variant="compact" title="Архив" />

      <button
        onClick={() => navigate("/projects")}
        className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-card text-left tap-row mb-[2px]"
      >
        <Icon name="chevronLeft" size={18} className="text-sub" />
        <span className="tf-body text-text">К проектам</span>
      </button>

      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить архив"
        variant="inline"
        className="mb-2 mt-2"
      />
      {actionError !== null && (
        <ErrorBanner
          error={actionError}
          fallback="Не удалось выполнить действие"
          variant="block"
          className="mb-2"
        />
      )}

      {isLoading && <Loading />}

      {projects.map((p) => (
        <ArchivedRow
          key={p.id}
          project={p}
          onRestore={handleRestore}
          onPurge={handlePurge}
          busy={busy}
        />
      ))}

      {!isLoading && !isError && projects.length === 0 && (
        <p className="tf-action px-1 text-dim mt-2">
          Архив пуст. Удалённые проекты попадают сюда, и отсюда их можно
          вернуть или удалить навсегда.
        </p>
      )}
    </div>
  );
}
