import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { todayStr, formatDueLabel } from "../lib/date";
import { Icon } from "../components/UI";
import { useOpenTask } from "../lib/useOpenTask";
import { isAgentAssignedTask } from "../lib/taskOwner";
import { useAgents } from "../api/agents";
import type { ApiTask } from "../api/types";

// ═══════════ TodayScreenTimeline — proof-of-concept «Time-Thread UI» ═══════════
//
// 30.08.2026, этап1 (владелец прислал HTML-референс с зум-слоями День/Неделя/
// Месяц и анимацией scale+blur при свайпе). Этот файл — ТОЛЬКО слой «День»,
// в минимальной версии: вертикальная time-line слева, задачи дня как точки
// на ней, заголовок экрана в едином стиле.
//
// Цель этапа1 — собрать обратную связь по визуалу, прежде чем пилить
// свайп + два других слоя. Если визуал ок — следующим коммитом добавим
// остальные слои.
//
// Пока не трогает TodayScreen.tsx — доступен за флагом /timeline. Решение
// о замене — после визуального одобрения на устройстве.
//
// Компонент НЕ включает в себя доску/проект-чипы/фильтры из TodayScreen —
// только список задач дня. Цель: показать новую геометрию.

export function TodayScreenTimeline() {
  const { data: allTasks = [], isLoading } = useTasks();
  const { data: agents = [] } = useAgents();
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const today = todayStr();

  // Только задачи на сегодня, отсортированные по времени (если есть).
  // Из того же расчёта, что в TodayScreen — агенты исключаются (они в
  // сетке часов не показываются), но стартовое время берётся.
  const todays = useMemo(() => {
    return allTasks
      .filter((t) => {
        if (!t.due_date) return false;
        if (t.status === "completed") return false;
        return t.due_date.startsWith(today);
      })
      .filter((t) => !isAgentAssignedTask(t, agents))
      .sort((a, b) => {
        // Сортировка по времени: задачи без времени идут после задач с временем.
        const ta = a.start_time ?? "";
        const tb = b.start_time ?? "";
        if (!ta && !tb) return (a.position ?? 0) - (b.position ?? 0);
        if (!ta) return 1;
        if (!tb) return -1;
        return ta.localeCompare(tb);
      });
  }, [allTasks, today, agents]);

  return (
    <div className="min-h-screen bg-bg text-text pb-12">
      {/* Шапка — единый стиль с референса (mix-blend-difference даёт
          инверсию цвета на любой подложке, как у Apple Music в light mode).
          В dark mode проекта blend-mode визуально неотличим от обычного
          белого текста; оставляю на случай, если когда-нибудь появится
          светлая тема. */}
      <header className="px-8 pt-12 pb-4">
        <div className="text-sm text-dim tracking-widest uppercase">
          Фокус дня
        </div>
        <div className="text-3xl font-medium mt-1">{formatDueLabel(today)}</div>
        <button
          onClick={() => navigate(-1)}
          className="mt-3 inline-flex items-center gap-1 text-[12px] text-sub hover:text-text transition-colors"
        >
          <Icon name="chevron" size={14} className="rotate-90" />
          <span>Назад (демо)</span>
        </button>
      </header>

      {/* Тело — вертикальная time-line слева (24px от края), задачи как
          точки на ней. */}
      <div className="relative px-8 pt-2">
        <div
          aria-hidden
          className="absolute left-[24px] top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
        />

        {isLoading ? (
          <div className="text-sub text-sm pl-8 py-8">Загрузка…</div>
        ) : todays.length === 0 ? (
          <div className="text-sub text-sm pl-8 py-8">
            На сегодня задач нет.
          </div>
        ) : (
          <div className="space-y-8">
            {todays.map((t) => (
              <TimelineTask key={t.id} task={t} onOpen={() => openTask(t.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Подсказка снизу — в референсе «СВАЙП ВЛЕВО/ВПРАВО ДЛЯ ЗУМА», но
          свайпа пока нет (этап1). Подсказка одна: «Time-Thread — этап1,
          только день». Это позволит сразу понять, что экран — POC. */}
      <div className="fixed bottom-12 left-1/2 -translate-x-1/2 text-[10px] text-neutral-600 tracking-widest uppercase">
        Time-Thread · Этап 1 из 4
      </div>
    </div>
  );
}

function TimelineTask({ task, onOpen }: { task: ApiTask; onOpen: () => void }) {
  const priorityColor =
    task.priority === 1
      ? "bg-red shadow-[0_0_8px_#e44332]"
      : task.priority === 2
        ? "bg-orange shadow-[0_0_8px_#ff9a14]"
        : task.priority === 3
          ? "bg-blue shadow-[0_0_8px_#4a9fd8]"
          : "bg-white";

  const time =
    task.start_time && task.duration_min
      ? `${task.start_time}—${formatEnd(task.start_time, task.duration_min)}`
      : task.start_time
        ? `${task.start_time}`
        : "Без времени";

  return (
    <button
      onClick={onOpen}
      className="relative pl-8 w-full text-left group"
    >
      <div
        aria-hidden
        className={`absolute left-[-4px] top-1.5 w-2 h-2 rounded-full ${priorityColor}`}
      />
      <div className="text-xs text-dim font-mono mb-1 tracking-widest">
        {time}
      </div>
      <div className="text-lg font-light leading-tight group-hover:text-text transition-colors">
        {task.title}
      </div>
    </button>
  );
}

function formatEnd(start: string, durationMin: number): string {
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}