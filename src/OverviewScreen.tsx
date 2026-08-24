import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, ScreenHeader } from "../components/UI";
import { WeeklySummaryModal } from "../components/WeeklySummaryModal";
import { BrainCircuit } from "lucide-react";
import { hapticTap } from "../lib/haptics";

export function OverviewScreen() {
  const navigate = useNavigate();
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  // Сводка вверху экрана — считается на клиенте из уже загруженного
  // useTasks() (тот же кэш react-query, что и TodayScreen/TaskDetailScreen),
  // без отдельного агрегирующего эндпоинта.
  const { data: allTasks = [] } = useTasks();
  const staleCount = useMemo(
    () =>
      allTasks.filter((t) => t.agent_state === "in_progress" && t.agent_stale)
        .length,
    [allTasks],
  );

  const reviewCount = useMemo(
    () => allTasks.filter((t) => t.status === "active" && t.agent_state === "review").length,
    [allTasks],
  );

  const blockedCount = useMemo(
    () => allTasks.filter((t) => t.status === "active" && t.agent_state === "blocked").length,
    [allTasks],
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

  return (
    <div className="px-4 pb-4">
      <ScreenHeader title="Обзор" />

      {/* Сводка агентских статусов (2x2 сетка) */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {/* 1. В работе */}
        <button
          onClick={() => navigate("/agent-work?focus=in_progress")}
          className={`tap-scale flex items-center justify-between p-3 rounded-2xl text-left ${
            workingCount > 0 ? "bg-blue/15 text-blue" : "bg-card text-sub"
          }`}
        >
          <div className="min-w-0">
            <div className="text-[12px] text-sub truncate">В работе</div>
            <div className={`text-[20px] font-bold ${workingCount > 0 ? "text-blue" : "text-text"}`}>
              {workingCount}
            </div>
          </div>
          <Icon name="activity" size={20} className={workingCount > 0 ? "text-blue" : "text-dim"} />
        </button>

        {/* 2. На проверке */}
        <button
          onClick={() => navigate("/agent-work?focus=review")}
          className={`tap-scale flex items-center justify-between p-3 rounded-2xl text-left ${
            reviewCount > 0 ? "bg-amber-500/15 text-amber-400" : "bg-card text-sub"
          }`}
        >
          <div className="min-w-0">
            <div className="text-[12px] text-sub truncate">На проверке</div>
            <div className={`text-[20px] font-bold ${reviewCount > 0 ? "text-amber-400" : "text-text"}`}>
              {reviewCount}
            </div>
          </div>
          <Icon name="check" size={20} className={reviewCount > 0 ? "text-amber-400" : "text-dim"} />
        </button>

        {/* 3. Заблокированы */}
        <button
          onClick={() => navigate("/agent-work?focus=blocked")}
          className={`tap-scale flex items-center justify-between p-3 rounded-2xl text-left ${
            blockedCount > 0 ? "bg-coral/20 text-coral" : "bg-card text-sub"
          }`}
        >
          <div className="min-w-0">
            <div className="text-[12px] text-sub truncate">Заблокированы</div>
            <div className={`text-[20px] font-bold ${blockedCount > 0 ? "text-coral" : "text-text"}`}>
              {blockedCount}
            </div>
          </div>
          <Icon name="flag" size={20} className={blockedCount > 0 ? "text-coral" : "text-dim"} />
        </button>

        {/* 4. Пропали */}
        <button
          onClick={() => navigate("/agent-work?focus=stale")}
          className={`tap-scale flex items-center justify-between p-3 rounded-2xl text-left ${
            staleCount > 0 ? "bg-coral/20 text-coral" : "bg-card text-sub"
          }`}
        >
          <div className="min-w-0">
            <div className="text-[12px] text-sub truncate">Пропали</div>
            <div className={`text-[20px] font-bold ${staleCount > 0 ? "text-coral" : "text-text"}`}>
              {staleCount}
            </div>
          </div>
          <Icon name="bot" size={20} className={staleCount > 0 ? "text-coral" : "text-dim"} />
        </button>
      </div>

      {/* Second Brain: Недельная сводка */}
      <button
        onClick={() => {
          hapticTap();
          setIsSummaryOpen(true);
        }}
        className="tap-row w-full flex items-center justify-between bg-card rounded-2xl p-4 mb-3 group"
      >
        <div className="flex items-center gap-3.5">
          <div className="w-[36px] h-[36px] rounded-xl bg-gradient-to-tr from-[#FF2D55] to-[#FF9500] flex items-center justify-center text-white shadow-md shadow-[#FF2D55]/20 shrink-0">
            <BrainCircuit className="w-5 h-5 text-white" />
          </div>
          <div className="text-left">
            <div className="text-[15px] font-semibold text-text flex items-center gap-2">
              Сводка недели
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-md bg-[#FF2D55]/20 text-[#FF2D55]">
                Second Brain
              </span>
            </div>
            <div className="text-[12px] text-sub">Победы, хвосты и фокус на цели недели</div>
          </div>
        </div>
        <Icon name="chevron" size={16} className="text-dim group-hover:text-text transition-colors" />
      </button>

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

      {/* Модальное окно сводки */}
      <WeeklySummaryModal
        isOpen={isSummaryOpen}
        onClose={() => setIsSummaryOpen(false)}
      />
    </div>
  );
}
