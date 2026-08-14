import { useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useCreateProject } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { useTasks } from "../api/tasks";
import { useAgents } from "../api/agents";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { ActionsMenu } from "../components/ActionsMenu";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { PROJECT_COLORS } from "../lib/projectColors";
import { partitionOverdueToday, todayStr } from "../lib/date";

export function OverviewScreen() {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useProjects();
  const createProject = useCreateProject();

  // Сводка вверху экрана — считается на клиенте из уже загруженного
  // useTasks() (тот же кэш react-query, что и TodayScreen/TaskDetailScreen),
  // без отдельного агрегирующего эндпоинта. "Просрочено" — через
  // partitionOverdueToday (lib/date.ts), ТУ ЖЕ функцию, что даёт красный
  // блок "Просрочено N" на "Сегодня", но это НЕ гарантирует одинаковое
  // число: TodayScreen после неё ещё вычитает задачи, ушедшие в «Ждут вас»
  // (blocked/review), а здесь считаются ВСЕ активные просроченные задачи
  // без вычета. Так и задумано для сводки "сколько всего просрочено" — но
  // при наличии просроченных задач в «Ждут вас» цифра тут будет БОЛЬШЕ,
  // чем заголовок "Просрочено N" на "Сегодня", и это не баг, а разная
  // семантика.
  // "Протухло у агентов" — то же условие, что и бейдж "Агент пропал"
  // (components/UI.tsx AgentStateTag): agent_stale вычисляется сервером и
  // осмыслен только вместе с agent_state === "in_progress"
  // (server/src/routes/tasks.ts withAgentStale).
  const { data: allTasks = [] } = useTasks();
  const today = todayStr();
  const overdueCount = useMemo(
    () => partitionOverdueToday(allTasks, today).overdue.length,
    [allTasks, today],
  );
  const staleCount = useMemo(
    () =>
      allTasks.filter((t) => t.agent_state === "in_progress" && t.agent_stale)
        .length,
    [allTasks],
  );

  // Присутствие агентов — тот же источник, что и на экране агентов
  // (useAgents сам перезапрашивается раз в 15 секунд, см. api/agents.ts),
  // поэтому плашка на главном экране не отстаёт от настроек. Считаются
  // только ИИ-учётки: вопрос «работает кто-то или нет» — про агентов, а не
  // про самого Максима, который и так сидит в приложении.
  const { data: allAgents = [] } = useAgents();
  const aiAgents = useMemo(
    () => allAgents.filter((a) => a.type === "ai"),
    [allAgents],
  );
  const agentsTotal = aiAgents.length;
  const agentsOnline = useMemo(
    () => aiAgents.filter((a) => a.status === "online").length,
    [aiAgents],
  );

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createProject.mutateAsync({ name: name.trim(), color });
    setName("");
    setColor(PROJECT_COLORS[0]);
    setShowCreate(false);
  });

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        className="mb-5"
        title={
          <span className="flex w-fit max-w-full items-center gap-2 bg-card px-3 py-1.5 rounded-full">
            {user && (
              <Avatar
                initials={user.initials}
                color={user.avatar_color}
                size={28}
              />
            )}
            <span className="min-w-0 truncate text-[16px] font-semibold">
              {user?.name}
            </span>
          </span>
        }
        actions={
          <>
            <button
              ref={menuAnchorRef}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Ещё"
              className="w-[44px] h-[44px] flex items-center justify-center"
            >
              <Icon name="dots" size={18} />
            </button>
            <ActionsMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorRef={menuAnchorRef}
              items={[
                {
                  icon: "bell",
                  label: "Уведомления",
                  onClick: () => navigate("/notifications"),
                },
                {
                  icon: "settings",
                  label: "Настройки",
                  onClick: () => navigate("/settings"),
                },
              ]}
            />
          </>
        }
      />

      {/* Сводка: просроченные задачи + протухшие аренды агентов, одним
          взглядом. Ноль — нейтральный цвет (bg-card2/text-sub), не тревожный. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            overdueCount > 0 ? "bg-red/15 text-red" : "bg-card2 text-sub"
          }`}
        >
          <Icon name="calendarSmall" size={14} />
          Просрочено: {overdueCount}
        </div>
        <div
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            staleCount > 0 ? "bg-coral/20 text-coral" : "bg-card2 text-sub"
          }`}
        >
          <Icon name="bot" size={14} />
          Протухло у агентов: {staleCount}
        </div>
        {/* «Кто сейчас на связи» — по просьбе Максима 14.08.2026: раньше это
            было видно только в настройках, а вопрос «работает кто-то или
            нет» возникает сходу, на главном экране. Плашка в том же ряду и
            том же стиле, что «Просрочено» и «Протухло», но кликабельная:
            ведёт на полный экран агентов, где видно и роли, и кто именно.
            Точка вместо иконки — тот же зелёный кружок присутствия, что и
            на экране агентов, чтобы признак читался одинаково в двух местах. */}
        <button
          onClick={() => navigate("/agents")}
          className={`tap-scale flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            agentsOnline > 0 ? "bg-green/15 text-green" : "bg-card2 text-sub"
          }`}
        >
          <span
            className={`w-[7px] h-[7px] rounded-full ${
              agentsOnline > 0 ? "bg-green" : "bg-dim"
            }`}
          />
          Агенты на связи: {agentsOnline} из {agentsTotal}
        </button>
      </div>

      {/* Search Card */}
      <button
        onClick={() => navigate("/search")}
        className="w-full flex items-center gap-3 bg-card rounded-2xl p-4 mb-4"
      >
        <Icon name="search" size={20} className="text-orange" />
        <span className="text-[15px] text-sub">Найти задачу или проект</span>
      </button>

      {/* Projects */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 px-1 -mr-2.5">
          <h3 className="text-[13px] font-semibold text-sub">Мои проекты</h3>
          <div className="flex items-center">
            <button
              onClick={() => navigate("/projects")}
              aria-label="Все проекты"
              className="w-[44px] h-[44px] flex items-center justify-center text-dim"
            >
              <Icon name="chevron" size={14} />
            </button>
            <button
              onClick={() => setShowCreate((v) => !v)}
              aria-label={
                showCreate ? "Отменить создание проекта" : "Создать проект"
              }
              className="w-[44px] h-[44px] flex items-center justify-center text-dim"
            >
              <Icon name={showCreate ? "x" : "plus"} size={16} />
            </button>
          </div>
        </div>

        {showCreate && (
          <form
            onSubmit={handleCreate}
            className="bg-card rounded-2xl p-4 mb-2"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название проекта"
              className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
            />
            <div className="flex items-center gap-2 mb-3">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label="Выбрать цвет"
                  className="w-[24px] h-[24px] rounded-full shrink-0"
                  style={{
                    backgroundColor: c,
                    outline: color === c ? "2px solid white" : "none",
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
            <ErrorBanner
              error={createProject.error}
              fallback="Не удалось создать проект"
              variant="block"
              className="mb-3"
            />
            <button
              type="submit"
              disabled={!name.trim() || createProject.isPending}
              className="w-full h-12 bg-red rounded-xl text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {createProject.isPending ? "Создаём…" : "Создать"}
            </button>
          </form>
        )}

        {isLoading && <p className="px-3 text-[13px] text-dim">Загрузка…</p>}

        {isError && (
          <div className="px-3 space-y-2">
            <ErrorBanner
              error={error}
              fallback="Не удалось загрузить проекты"
              variant="inline"
              className="px-0"
            />
            <button
              onClick={() => refetch()}
              className="min-h-[44px] px-3 -ml-3 text-[13px] text-red font-semibold"
            >
              Повторить
            </button>
          </div>
        )}

        {!isLoading && !isError && (
          <div className="space-y-[2px]">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="w-full flex items-center gap-3 py-2.5 px-3 bg-card rounded-xl text-left min-h-[44px]"
              >
                <Icon name="hash" size={18} style={{ color: p.color }} />
                <span className="text-[14px] text-text flex-1">{p.name}</span>
                <span className="text-[13px] text-sub">{p.task_count}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="px-3 text-[13px] text-dim">Проектов пока нет</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
