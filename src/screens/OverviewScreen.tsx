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
  // без отдельного агрегирующего эндпоинта.
  //
  // Своих просроченных задач тут намеренно НЕТ (убрано по просьбе Максима
  // 14.08.2026): для них есть «Сегодня» с красным блоком «Просрочено N», и
  // вторая цифра рядом только сбивала — она считалась без вычета задач,
  // ушедших в «Ждут вас», то есть законно расходилась с той, что на
  // «Сегодня». Сводка здесь отвечает на другой вопрос — что происходит у
  // агентов, а не что просрочено у самого Максима.
  //
  // "Пропали" — то же условие, что и бейдж "Агент пропал"
  // (components/UI.tsx AgentStateTag): agent_stale вычисляется сервером и
  // осмыслен только вместе с agent_state === "in_progress"
  // (server/src/routes/tasks.ts withAgentStale).
  const { data: allTasks = [] } = useTasks();
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

      {/* Сводка по агентам одной строкой: кто на связи и у кого протухла
          аренда. Ноль — нейтральный цвет (bg-card2/text-sub), не тревожный.
          Своих просроченных задач тут больше нет (см. комментарий к
          подсчётам выше) — для них есть «Сегодня».

          Обе плашки — одна строка на всю ширину, по половине каждая
          (просьба Максима 14.08.2026): flex-1 с basis-0 делит доступные
          358px (100vw минус px-4 с двух сторон) пополам — по 175px на
          плашку при gap-2. Подписи с иконкой и полями укладываются
          примерно в 150px, запас есть даже на «10 из 10». flex-wrap снят
          намеренно: с ним перенос вернулся бы молча, стоит подписи чуть
          подрасти; min-w-0 + truncate на этот случай оставляют плашку в
          строке, подрезая текст, а не ломая раскладку.

          «Протухло» ушло по прямому замечанию Максима — слово не из этой
          области. Взято «Пропали», тем же словом, что и бейдж «Агент
          пропал» на самой карточке (components/UI.tsx AgentStateTag), так
          что одно и то же состояние называется одинаково везде. */}
      <div className="flex items-stretch gap-2 mb-4">
        {/* «Кто сейчас на связи» — по просьбе Максима 14.08.2026: раньше это
            было видно только в настройках, а вопрос «работает кто-то или
            нет» возникает сходу, на главном экране. Иконка та же, что у
            соседней плашки (бот), и она же загорается зелёным, когда
            кто-то на связи — цвет наследуется от текста, отдельной точки
            присутствия здесь не нужно. Кликабельна: ведёт на полный экран
            агентов, где видно, кто именно и в какой роли. */}
        <button
          onClick={() => navigate("/agents")}
          className={`tap-scale flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            agentsOnline > 0 ? "bg-green/15 text-green" : "bg-card2 text-sub"
          }`}
        >
          <Icon name="bot" size={14} className="shrink-0" />
          <span className="truncate">
            На связи: {agentsOnline} из {agentsTotal}
          </span>
        </button>
        <div
          className={`flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            staleCount > 0 ? "bg-coral/20 text-coral" : "bg-card2 text-sub"
          }`}
        >
          <Icon name="bot" size={14} className="shrink-0" />
          <span className="truncate">Пропали: {staleCount}</span>
        </div>
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
