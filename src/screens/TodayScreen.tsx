import { useMemo } from "react";
import { useTasks } from "../api/tasks";
import { Icon, ScreenHeader } from "../components/UI";
import { todayStr } from "../lib/date";

export function TodayScreen() {
  const { data: allTasks = [], isLoading } = useTasks();
  const tasks = useMemo(
    () =>
      allTasks.filter(
        (t) => t.due_date === todayStr() && t.status === "active",
      ),
    [allTasks],
  );

  if (!isLoading && tasks.length === 0) {
    return (
      <div className="px-4 pb-4 flex flex-col items-center">
        <ScreenHeader
          className="w-full"
          leading={
            <div className="bg-card/60 rounded-full p-2">
              <Icon name="calendarSmall" size={22} className="text-text" />
            </div>
          }
          title="Сегодня"
          actions={
            <>
              <button className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center">
                <Icon name="dots" size={18} />
              </button>
              <button className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center">
                <Icon name="search" size={18} />
              </button>
            </>
          }
        />
        <div className="flex-1 flex flex-col items-center justify-center mt-8">
          <svg width="200" height="180" viewBox="0 0 200 180" className="mb-6">
            <circle cx="100" cy="80" r="48" fill="#2B2B2B" />
            <circle cx="85" cy="72" r="4" fill="white" />
            <circle cx="115" cy="72" r="4" fill="white" />
            <path
              d="M88 90 Q100 100 112 90"
              stroke="white"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <ellipse
              cx="68"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(-20 68 55)"
            />
            <ellipse
              cx="132"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(20 132 55)"
            />
            <circle
              cx="50"
              cy="130"
              r="18"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="150"
              cy="120"
              r="14"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="80"
              cy="150"
              r="10"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="1.5"
            />
          </svg>
          <h3 className="text-[17px] font-semibold mb-2">
            Чёткое видение грядущего дня
          </h3>
          <p className="text-[14px] text-sub text-center px-8 leading-relaxed">
            Задачи на сегодня появятся здесь, когда вы назначите дедлайн.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        leading={
          <div className="bg-card/60 rounded-full p-2">
            <Icon name="calendarSmall" size={22} className="text-text" />
          </div>
        }
        title="Сегодня"
      />
      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      <div className="space-y-[2px]">
        {tasks.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-3 py-3 px-1 border-b border-stroke/50"
          >
            <div className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 border-red shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] text-text leading-snug truncate">
                {t.title}
              </div>
              {t.description && (
                <div className="text-[13px] text-sub mt-0.5 truncate">
                  {t.description.substring(0, 60)}…
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
