// Экран Архива задач (карточка 57c69735…). Серверный GET /api/tasks?
// archived=true возвращает только архивные карточки (фильтр archived_at IS NULL
// снимается в этой ветке). Для владельца попасть сюда можно прямым
// маршрутом /tasks/archive. Действия — те же, что и в Архиве проектов:
// «Вернуть» (POST /api/tasks/:id/restore) и «Удалить навсегда» (DELETE
// /api/tasks/:id, сервер сам делает purge, т.к. вызывающий — владелец
// архивной карточки). Удалить навсегда неархивную нельзя, и сервер это
// гарантирует 409 — но попасть в неархивную карточку через этот экран
// нельзя по построению, поэтому дополнительных проверок на вебе нет.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useArchivedTasks,
  useRestoreTask,
  useDeleteTask,
} from "../api/tasks";
import type { ApiTask } from "../api/types";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { taskWord } from "../lib/pluralize";

function ArchivedTaskRow({
  task,
  onRestore,
  onPurge,
  busy,
}: {
  task: ApiTask;
  onRestore: (t: ApiTask) => void;
  onPurge: (t: ApiTask) => void;
  busy: boolean;
}) {
  // Числа для подтверждения «Удалить навсегда» — отдельные ручки сервера
  // не отдают, поэтому считаем из того, что прислал гидратированный таск:
  // subtasks и labels, attachments/comments на архивном списке не
  // приходят (полные events/comments только на GET /api/tasks/:id), а
  // владельцу достаточно видеть подзадачи — это самое непрозрачное место
  // при окончательном удалении.
  const subtasks = task.subtasks ?? [];
  const openCount = subtasks.filter((s) => !s.done).length;

  return (
      <div className="bg-card rounded-xl p-4 mb-[2px]">
        <div className="flex items-start gap-3">
          {task.project_color && (
            <div
              className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: task.project_color + "20" }}
            >
              <Icon
                name="hash"
                size={16}
                style={{ color: task.project_color }}
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="tf-body text-text truncate">{task.title}</div>
            <div className="tf-meta text-sub">
              {task.project_name ? `${task.project_name} · ` : ""}
              {subtasks.length === 0
                ? "без подзадач"
                : `${subtasks.length} ${taskWord(subtasks.length)}`}
              {openCount > 0 && ` · ${openCount} не выполнено`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRestore(task)}
            className="tf-row flex-1 h-10 rounded-xl bg-card2 text-text tap-row disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Icon name="restore" size={16} />
            Вернуть
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPurge(task)}
            className="tf-row flex-1 h-10 rounded-xl bg-red text-white tap-fade disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Icon name="trash" size={16} />
            Удалить навсегда
          </button>
        </div>
      </div>
    );
}

export function TaskArchiveScreen() {
  const navigate = useNavigate();
  const { data: tasks = [], isLoading, isError, error } = useArchivedTasks();
  const restoreTask = useRestoreTask();
  const deleteTask = useDeleteTask();
  const { confirm, dialog } = useDialog();
  const [actionError, setActionError] = useState<unknown>(null);

  const handleRestore = useGuardedCallback(async (task: ApiTask) => {
    // 409 «project_archived» (восстановление в архивный проект) на сервере
    // не пускает — поясняем заранее.
    const ok = await confirm({
      title: `Вернуть задачу «${task.title}»?`,
      description:
        "Задача снова появится в обычных списках. Проект этой задачи должен быть живым — иначе сервер не даст восстановить.",
      confirmLabel: "Вернуть",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await restoreTask.mutateAsync(task.id);
    } catch (err) {
      setActionError(err);
    }
  });

  const handlePurge = useGuardedCallback(async (task: ApiTask) => {
    const subtasks = task.subtasks ?? [];
    const ok = await confirm({
      title: `Удалить задачу «${task.title}» навсегда?`,
      description:
        `Будут уничтожены: задача и ${subtasks.length} ${taskWord(subtasks.length)}. ` +
        "Это действие нельзя отменить. Если у неё есть дочерние карточки, сервер не даст удалить — сначала разберитесь с ними.",
      confirmLabel: "Удалить навсегда",
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      // DELETE /api/tasks/:id от владельца архивной карточки — purge
      // (server/src/routes/tasks.ts:2125-…). useDeleteTask уже делает всю
      // нужную инвалидацию кэша (tasks/tasks:archive/projects).
      await deleteTask.mutateAsync(task.id);
    } catch (err) {
      setActionError(err);
    }
  });

  const busy = restoreTask.isPending || deleteTask.isPending;

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader variant="compact" title="Архив задач" />

      <button
        onClick={() => navigate(-1)}
        className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-card text-left tap-row mb-[2px]"
      >
        <Icon name="chevronLeft" size={18} className="text-sub" />
        <span className="tf-body text-text">Назад</span>
      </button>

      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить архив задач"
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

      {tasks.map((t) => (
        <ArchivedTaskRow
          key={t.id}
          task={t}
          onRestore={handleRestore}
          onPurge={handlePurge}
          busy={busy}
        />
      ))}

      {!isLoading && !isError && tasks.length === 0 && (
        <p className="tf-action px-1 text-dim mt-2">
          Архив задач пуст. Удалённые задачи попадают сюда — отсюда их можно
          вернуть или удалить навсегда.
        </p>
      )}
    </div>
  );
}