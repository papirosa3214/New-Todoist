import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { Icon } from "../components/UI";
import { MarkdownInline } from "../components/MarkdownInline";
import { useOpenTask } from "../lib/useOpenTask";
import type { ApiTask, ApiProject } from "../api/types";

// ═══════════ InboxScreenTimeline — POC time-thread для Входящих ═══════════
//
// 30.08.2026, этап1 для Inbox (по HTML-референсу). Идея та же, что и
// TodayScreenTimeline: вертикальная time-line слева, задачи как точки
// на ней. Только тут нет времени — задачи во Входящих без срока; вместо
// «времени» показываем название проекта цветной точкой + цветной
// левой границей карточки.
//
// Доступ: /inbox-timeline (POC, рядом с /timeline от Today). Реальный
// InboxScreen.tsx не трогаем — это экспериментальный экран.

export function InboxScreenTimeline() {
  const { data: allTasks = [], isLoading } = useTasks();
  const { data: projects = [] } = useProjects();
  const openTask = useOpenTask();
  const navigate = useNavigate();

  // Только активные задачи без проекта — это и есть «Входящие».
  const inbox = useMemo(() => {
    return allTasks
      .filter((t) => t.status === "active")
      .filter((t) => !t.project_id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }, [allTasks]);

  const projectById = useMemo(() => {
    const map = new Map<string, ApiProject>();
    projects.forEach((p) => map.set(p.id, p));
    return map;
  }, [projects]);

  return (
    <div className="min-h-screen bg-bg text-text pb-12">
      <header className="px-8 pt-12 pb-4">
        <div className="text-sm text-dim tracking-widest uppercase">
          Входящие
        </div>
        <div className="text-3xl font-medium mt-1">
          {inbox.length === 0
            ? "Пусто"
            : inbox.length === 1
              ? "1 задача"
              : `${inbox.length} задач`}
        </div>
        <button
          onClick={() => navigate(-1)}
          className="mt-3 inline-flex items-center gap-1 text-[12px] text-sub hover:text-text transition-colors"
        >
          <Icon name="chevron" size={14} className="rotate-90" />
          <span>Назад (демо)</span>
        </button>
      </header>

      <div className="relative px-8 pt-2">
        <div
          aria-hidden
          className="absolute left-[24px] top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
        />

        {isLoading ? (
          <div className="text-sub text-sm pl-8 py-8">Загрузка…</div>
        ) : inbox.length === 0 ? (
          <div className="text-sub text-sm pl-8 py-8">
            Во Входящих пусто.
          </div>
        ) : (
          <div className="space-y-8">
            {inbox.map((t) => (
              <TimelineInboxTask
                key={t.id}
                task={t}
                project={t.project_id ? projectById.get(t.project_id) : undefined}
                onOpen={() => openTask(t.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="fixed bottom-12 left-1/2 -translate-x-1/2 text-[10px] text-neutral-600 tracking-widest uppercase">
        Inbox · Time-Thread · Этап 1
      </div>
    </div>
  );
}

function TimelineInboxTask({
  task,
  project,
  onOpen,
}: {
  task: ApiTask;
  project: ApiProject | undefined;
  onOpen: () => void;
}) {
  const priorityColor =
    task.priority === 1
      ? "bg-red shadow-[0_0_8px_#e44332]"
      : task.priority === 2
        ? "bg-orange shadow-[0_0_8px_#ff9a14]"
        : task.priority === 3
          ? "bg-blue shadow-[0_0_8px_#4a9fd8]"
          : "bg-white";

  const projectColor = project?.color;

  return (
    <button
      onClick={onOpen}
      className="relative pl-8 w-full text-left group"
    >
      <div
        aria-hidden
        className={`absolute left-[-4px] top-1.5 w-2 h-2 rounded-full ${priorityColor}`}
      />
      {/* Если у задачи всё-таки проект (исключение: сюда попадают только
          задачи без project_id, но на случай рассинхрона фильтра и
          серверной логики — показываем цвет проекта мини-полоской). */}
      {projectColor && (
        <span
          aria-hidden
          className="absolute left-[-20px] top-2 bottom-2 w-[2px] rounded-full opacity-60"
          style={{ backgroundColor: projectColor }}
        />
      )}
      <div className="text-xs text-dim font-mono mb-1 tracking-widest uppercase">
        {project ? project.name : "Без проекта"}
      </div>
      <div className="text-lg font-light leading-tight group-hover:text-text transition-colors">
        <MarkdownInline source={task.title} />
      </div>
    </button>
  );
}