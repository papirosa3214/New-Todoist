import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import {
  useAgents,
  useAgentService,
  useToggleAgentService,
} from "../api/agents";
import { Icon, ScreenHeader } from "../components/UI";

export function OverviewScreen() {
  const navigate = useNavigate();

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
  // Состояние берём у самой службы, а не по косвенному признаку «онлайн ли
  // ИИ-учётка»: плашка теперь не только показывает режим, но и переключает
  // его, а переключатель обязан отражать то, чем управляет. Косвенный
  // признак к тому же врал бы в первые секунды после включения — соединение
  // открывается не мгновенно.
  const { data: service } = useAgentService();
  const toggleService = useToggleAgentService();
  const serviceOn = service?.active ?? false;
  // Список агентов нужен отдельно — по нему считаются задачи, назначенные
  // ИИ-учёткам и никем не взятые (waitingCount ниже).
  const { data: allAgents = [] } = useAgents();
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
  // Назначено агенту, но никто не взял. Пока служба дежурит, это нормальная
  // очередь — подхватит. А вот при выключенной службе ровно эти задачи и
  // зависнут молча: назначил и ждёшь, а никто не придёт. Именно этого
  // Максим и опасался, поэтому плашка дежурства становится тревожной не
  // «когда служба выключена» вообще (её можно и не включать, работая через
  // MCP руками), а когда выключена И есть кому простаивать.
  const waitingCount = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          t.status === "active" &&
          !t.agent_state &&
          !!t.assignee_id &&
          allAgents.some((a) => a.id === t.assignee_id && a.type === "ai"),
      ).length,
    [allTasks, allAgents],
  );
  const serviceAlarm = !serviceOn && waitingCount > 0;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader title="Обзор" />

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
        {/* 1. Дежурство — про СЛУЖБУ, а не про агентов */}
        <button
          role="switch"
          aria-checked={serviceOn}
          aria-label="Автономный режим: служба сама поднимает агента по назначенной задаче"
          disabled={toggleService.isPending}
          onClick={() => toggleService.mutate(!serviceOn)}
          className={`tap-scale flex h-11 flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 px-2 rounded-xl text-[13px] font-semibold whitespace-nowrap disabled:opacity-60 ${
            serviceOn
              ? "bg-green/15 text-green"
              : serviceAlarm
                ? "bg-coral/20 text-coral"
                : "bg-card2 text-sub"
          }`}
        >
          <span
            className={`w-[7px] h-[7px] rounded-full shrink-0 ${
              serviceOn ? "bg-green" : serviceAlarm ? "bg-coral" : "bg-dim"
            }`}
          />
          <span className="truncate">
            {serviceOn
              ? "Дежурит"
              : serviceAlarm
                ? `Выключен: ${waitingCount}`
                : "Выключен"}
          </span>
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
        className="tap-row w-full flex items-center gap-3 bg-card rounded-2xl p-4 mb-4"
      >
        <Icon name="search" size={20} className="text-orange" />
        <span className="text-[15px] text-sub">Найти задачу или проект</span>
      </button>

      {/* Quick Navigation Cards: Уведомления и Активность */}
      <div className="space-y-2">
        <button
          onClick={() => navigate("/notifications")}
          className="tap-row w-full flex items-center justify-between bg-card rounded-2xl p-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-[32px] h-[32px] rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-500">
              <Icon name="bell" size={18} />
            </div>
            <div className="text-left">
              <div className="text-[15px] font-medium text-text">Уведомления</div>
              <div className="text-[12px] text-sub">История событий и напоминаний</div>
            </div>
          </div>
          <Icon name="chevron" size={16} className="text-dim" />
        </button>

        <button
          onClick={() => navigate("/activity")}
          className="tap-row w-full flex items-center justify-between bg-card rounded-2xl p-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-[32px] h-[32px] rounded-xl bg-blue-500/15 flex items-center justify-center text-blue-400">
              <Icon name="activity" size={18} />
            </div>
            <div className="text-left">
              <div className="text-[15px] font-medium text-text">Активность и статистика</div>
              <div className="text-[12px] text-sub">Графики продуктивности и выполненные задачи</div>
            </div>
          </div>
          <Icon name="chevron" size={16} className="text-dim" />
        </button>
      </div>
    </div>
  );
}
