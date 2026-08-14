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

  // Дежурство службы. Служба-будильник держит соединение под учёткой
  // агента, поэтому «хотя бы одна ИИ-учётка онлайн» и есть признак того,
  // что назначенная задача будет подхвачена. Двойники, которых служба
  // запускает, своих соединений не открывают — считать их здесь нечего,
  // занятость показывает соседняя плашка «В работе».
  const { data: allAgents = [] } = useAgents();
  const serviceOn = useMemo(
    () => allAgents.some((a) => a.type === "ai" && a.status === "online"),
    [allAgents],
  );
  // Занятость — по задачам, а не по учёткам: сколько карточек агенты
  // реально делают сейчас. Протухшие сюда не входят, для них своя плашка.
  const workingCount = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          t.status === "active" &&
          t.agent_state === "in_progress" &&
          !t.agent_stale,
      ).length,
    [allTasks],
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

      {/* Сводка агентского слоя, три плашки в одну строку: работает ли
          служба, сколько задач в работе, сколько брошено. Ноль —
          нейтральный цвет (bg-card2/text-sub), тревожная из трёх только
          «Пропали». Своих просроченных задач тут нет (см. комментарий к
          подсчётам выше) — для них есть «Сегодня».

          Размеры считаны, а не подобраны на глаз. Доступная ширина на
          390px-экране: 100vw − px-4 с двух сторон = 358px; при gap-2 (8px)
          три flex-1 basis-0 дают ровно (358 − 16) / 3 = 114px на плашку.
          Подписи при 13px semibold (кириллица ~7.2px на символ) и px-2
          (8px с каждой стороны): «Дежурит» ≈ 79px, «Выключен» ≈ 87px,
          «В работе: 12» ≈ 102px, «Пропали: 12» ≈ 95px — запас есть у всех,
          включая двузначные числа. Прежняя подпись «На дежурстве» (≈123px)
          не помещалась и обрезалась бы — потому и укорочена.

          Высота h-11 = 44px: все три кликабельны, это минимальная зона
          нажатия, принятая в проекте. flex-wrap снят намеренно — с ним
          перенос вернулся бы молча, стоит подписи подрасти; min-w-0 +
          truncate на этот случай оставляют плашку в строке, подрезая
          текст, а не ломая раскладку. */}
      <div className="flex items-stretch gap-2 mb-4">
        {/* 1. Дежурство — про СЛУЖБУ, а не про агентов (уточнение Максима
            14.08.2026): «на связи» читалось как «агент работает», хотя
            отвечает на другой вопрос — подхватится ли задача, если её
            назначить. Признак: служба держит соединение под учёткой агента
            (server/src/ws.ts), поэтому онлайн хотя бы одной ИИ-учётки и
            означает «приём задач работает». Кто именно из агентов доступен,
            видно там, где это и нужно — при выборе исполнителя и в
            настройках, а не в сводке. */}
        <button
          onClick={() => navigate("/agents")}
          className={`tap-scale flex h-11 flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 px-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            serviceOn ? "bg-green/15 text-green" : "bg-card2 text-sub"
          }`}
        >
          <span
            className={`w-[7px] h-[7px] rounded-full shrink-0 ${
              serviceOn ? "bg-green" : "bg-dim"
            }`}
          />
          <span className="truncate">{serviceOn ? "Дежурит" : "Выключен"}</span>
        </button>
        {/* 2. В работе — сколько задач агенты делают прямо сейчас. */}
        <button
          onClick={() => navigate("/agent-work")}
          className={`tap-scale flex h-11 flex-1 basis-0 min-w-0 items-center justify-center px-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            workingCount > 0 ? "bg-blue/15 text-blue" : "bg-card2 text-sub"
          }`}
        >
          <span className="truncate">В работе: {workingCount}</span>
        </button>
        {/* 3. Пропали — взялись и замолчали: единственная тревожная из трёх. */}
        <button
          onClick={() => navigate("/agent-work?focus=stale")}
          className={`tap-scale flex h-11 flex-1 basis-0 min-w-0 items-center justify-center px-2 rounded-xl text-[13px] font-semibold whitespace-nowrap ${
            staleCount > 0 ? "bg-coral/20 text-coral" : "bg-card2 text-sub"
          }`}
        >
          <span className="truncate">Пропали: {staleCount}</span>
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
