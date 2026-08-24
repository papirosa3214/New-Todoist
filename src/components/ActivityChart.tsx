import { useMemo, useState, useEffect } from "react";
import { Icon } from "./UI";
import { todayStr, addDays, MONTHS_SHORT } from "../lib/date";
import type { ApiTask } from "../api/types";

export type ChartType = "line" | "donut";

export type ActivityPeriod = "week" | "month" | "quarter" | "year";

interface ChartPoint {
  key: string;
  label: string;
  shortLabel: string;
  assigned: number;
  completed: number;
  active: number;
  overdue: number;
  onTrack: number;
  dates: string[];
}

interface DrillDownScope {
  type: "week" | "month";
  title: string;
  parentPeriodLabel: string;
  dates: string[];
}

const WEEKDAYS_RU = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const MONTHS_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
];
const MONTHS_SHORT_RU = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
  "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"
];

// Цвета дизайн-системы TaskFlow
const COLOR_GREEN = "#15937e";
const COLOR_BLUE = "#4a9fd8";
const COLOR_CORAL = "#ff6b6b";

function parseTaskCompletionDate(task: ApiTask): string | null {
  const raw = task.completed_at || (task.status === "completed" ? task.updated_at : null);
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function ActivityChart({
  tasks,
  period = "week",
}: {
  tasks: ApiTask[];
  period?: ActivityPeriod;
  onPeriodChange?: (p: ActivityPeriod) => void;
}) {
  const [chartType, setChartType] = useState<ChartType>("line");
  const [selectedPointIdx, setSelectedPointIdx] = useState<number | null>(null);
  const [singleDayDate, setSingleDayDate] = useState<string | null>(null);
  const [drillDownScope, setDrillDownScope] = useState<DrillDownScope | null>(null);

  const today = todayStr();
  const now = new Date();

  // При смене внешнего фильтра периода сбрасываем локальный drill-down
  useEffect(() => {
    setDrillDownScope(null);
    setSingleDayDate(null);
    setSelectedPointIdx(null);
  }, [period]);

  // Генерация точек графика в зависимости от периода или drill-down диапазона:
  const chartPoints: ChartPoint[] = useMemo(() => {
    const points: ChartPoint[] = [];
    const currM = now.getMonth();
    const currY = now.getFullYear();

    // ── 1. Режим детального просмотра (Drill-Down) ──
    if (drillDownScope) {
      if (drillDownScope.type === "week") {
        for (const dStr of drillDownScope.dates) {
          const dObj = new Date(dStr + "T00:00:00");
          const dow = WEEKDAYS_RU[dObj.getDay()];
          const dayNum = dObj.getDate();
          const mShort = MONTHS_SHORT[dObj.getMonth()];

          const completedCount = tasks.filter((t) => parseTaskCompletionDate(t) === dStr).length;
          const assignedOnDate = tasks.filter((t) => t.due_date === dStr).length;
          const activeOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active").length;
          const overdueOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active" && dStr < today).length;
          const onTrackOnDate = Math.max(0, activeOnDate - overdueOnDate);

          points.push({
            key: dStr,
            label: `${dayNum} ${mShort} (${dow})`,
            shortLabel: `${dow} ${dayNum}`,
            assigned: Math.max(assignedOnDate, completedCount),
            completed: completedCount,
            active: activeOnDate,
            overdue: overdueOnDate,
            onTrack: onTrackOnDate,
            dates: [dStr],
          });
        }
        return points;
      }

      if (drillDownScope.type === "month") {
        for (const dStr of drillDownScope.dates) {
          const dObj = new Date(dStr + "T00:00:00");
          const dow = WEEKDAYS_RU[dObj.getDay()];
          const dayNum = dObj.getDate();
          const mShort = MONTHS_SHORT[dObj.getMonth()];

          const completedCount = tasks.filter((t) => parseTaskCompletionDate(t) === dStr).length;
          const assignedOnDate = tasks.filter((t) => t.due_date === dStr).length;
          const activeOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active").length;
          const overdueOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active" && dStr < today).length;
          const onTrackOnDate = Math.max(0, activeOnDate - overdueOnDate);

          points.push({
            key: dStr,
            label: `${dayNum} ${mShort} (${dow})`,
            shortLabel: String(dayNum),
            assigned: Math.max(assignedOnDate, completedCount),
            completed: completedCount,
            active: activeOnDate,
            overdue: overdueOnDate,
            onTrack: onTrackOnDate,
            dates: [dStr],
          });
        }
        return points;
      }
    }

    // ── 2. Стандартные периоды ──

    // Неделя: 7 дней (точки = дни)
    if (period === "week") {
      for (let i = 6; i >= 0; i--) {
        const dStr = addDays(today, -i);
        const dObj = new Date(dStr + "T00:00:00");
        const dow = WEEKDAYS_RU[dObj.getDay()];
        const dayNum = dObj.getDate();
        const mShort = MONTHS_SHORT[dObj.getMonth()];

        const completedCount = tasks.filter((t) => parseTaskCompletionDate(t) === dStr).length;
        const assignedOnDate = tasks.filter((t) => t.due_date === dStr).length;
        const activeOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active").length;
        const overdueOnDate = tasks.filter((t) => t.due_date === dStr && t.status === "active" && dStr < today).length;
        const onTrackOnDate = Math.max(0, activeOnDate - overdueOnDate);

        points.push({
          key: dStr,
          label: `${dayNum} ${mShort} (${dow})`,
          shortLabel: dow,
          assigned: Math.max(assignedOnDate, completedCount),
          completed: completedCount,
          active: activeOnDate,
          overdue: overdueOnDate,
          onTrack: onTrackOnDate,
          dates: [dStr],
        });
      }
      return points;
    }

    // Месяц: 1..сегодня (точки = дни)
    if (period === "month") {
      const dayOfMonth = now.getDate();
      for (let d = 1; d <= dayOfMonth; d++) {
        const mStr = String(currM + 1).padStart(2, "0");
        const dStr = String(d).padStart(2, "0");
        const fullDate = `${currY}-${mStr}-${dStr}`;
        const dObj = new Date(fullDate + "T00:00:00");
        const dow = WEEKDAYS_RU[dObj.getDay()];

        const completedCount = tasks.filter((t) => parseTaskCompletionDate(t) === fullDate).length;
        const assignedOnDate = tasks.filter((t) => t.due_date === fullDate).length;
        const activeOnDate = tasks.filter((t) => t.due_date === fullDate && t.status === "active").length;
        const overdueOnDate = tasks.filter((t) => t.due_date === fullDate && t.status === "active" && fullDate < today).length;
        const onTrackOnDate = Math.max(0, activeOnDate - overdueOnDate);

        points.push({
          key: fullDate,
          label: `${d} ${MONTHS_SHORT[currM]} (${dow})`,
          shortLabel: String(d),
          assigned: Math.max(assignedOnDate, completedCount),
          completed: completedCount,
          active: activeOnDate,
          overdue: overdueOnDate,
          onTrack: onTrackOnDate,
          dates: [fullDate],
        });
      }
      return points;
    }

    // 3 месяца: 12 недель (каждая точка = 1 неделя)
    if (period === "quarter") {
      for (let w = 11; w >= 0; w--) {
        const endDayOffset = w * 7;
        const startDayOffset = endDayOffset + 6;
        const startDStr = addDays(today, -startDayOffset);
        const endDStr = addDays(today, -endDayOffset);

        const weekDates: string[] = [];
        for (let i = startDayOffset; i >= endDayOffset; i--) {
          weekDates.push(addDays(today, -i));
        }

        const datesSet = new Set(weekDates);
        const completedCount = tasks.filter((t) => {
          const cd = parseTaskCompletionDate(t);
          return cd && datesSet.has(cd);
        }).length;

        const assignedCount = tasks.filter((t) => t.due_date && datesSet.has(t.due_date)).length;
        const activeCount = tasks.filter((t) => t.due_date && datesSet.has(t.due_date) && t.status === "active").length;
        const overdueCount = tasks.filter((t) => t.due_date && datesSet.has(t.due_date) && t.status === "active" && t.due_date < today).length;
        const onTrackCount = Math.max(0, activeCount - overdueCount);

        const startObj = new Date(startDStr + "T00:00:00");
        const endObj = new Date(endDStr + "T00:00:00");

        points.push({
          key: `week-${w}`,
          label: `${startObj.getDate()} ${MONTHS_SHORT[startObj.getMonth()]} — ${endObj.getDate()} ${MONTHS_SHORT[endObj.getMonth()]}`,
          shortLabel: `Н${12 - w}`,
          assigned: Math.max(assignedCount, completedCount),
          completed: completedCount,
          active: activeCount,
          overdue: overdueCount,
          onTrack: onTrackCount,
          dates: weekDates,
        });
      }
      return points;
    }

    // Год: месяцы с начала года (каждая точка = 1 месяц)
    for (let m = 0; m <= currM; m++) {
      const mStr = String(m + 1).padStart(2, "0");
      const monthPrefix = `${currY}-${mStr}-`;

      // Генерация всех дней этого месяца
      const lastDayOfMonth = new Date(currY, m + 1, 0).getDate();
      const monthDates: string[] = [];
      for (let d = 1; d <= lastDayOfMonth; d++) {
        monthDates.push(`${currY}-${mStr}-${String(d).padStart(2, "0")}`);
      }

      const completedCount = tasks.filter((t) => {
        const cd = parseTaskCompletionDate(t);
        return cd && cd.startsWith(monthPrefix);
      }).length;

      const assignedCount = tasks.filter((t) => t.due_date && t.due_date.startsWith(monthPrefix)).length;
      const activeCount = tasks.filter((t) => t.due_date && t.due_date.startsWith(monthPrefix) && t.status === "active").length;
      const overdueCount = tasks.filter((t) => t.due_date && t.due_date.startsWith(monthPrefix) && t.status === "active" && t.due_date < today).length;
      const onTrackCount = Math.max(0, activeCount - overdueCount);

      points.push({
        key: `month-${m}`,
        label: `${MONTHS_NAMES_RU[m]} ${currY}`,
        shortLabel: MONTHS_SHORT_RU[m],
        assigned: Math.max(assignedCount, completedCount),
        completed: completedCount,
        active: activeCount,
        overdue: overdueCount,
        onTrack: onTrackCount,
        dates: monthDates,
      });
    }
    return points;
  }, [period, tasks, today, drillDownScope]);

  // Обработка тапа по точке: точный Drill-Down в выбранный диапазон дат
  const handlePointClick = (idx: number) => {
    const pt = chartPoints[idx];
    if (!pt) return;

    // Если мы уже в drill-down или на днях («Неделя» / «Месяц»):
    // Клик по дню открывает Кольцо для этого конкретного дня!
    if (drillDownScope || period === "week" || period === "month") {
      setSelectedPointIdx(idx);
      setSingleDayDate(pt.key);
      setChartType("donut");
      return;
    }

    // Если на графике «Год» — переходим в конкретный выбранный месяц
    if (period === "year") {
      setSelectedPointIdx(null);
      setDrillDownScope({
        type: "month",
        title: pt.label,
        parentPeriodLabel: "Год",
        dates: pt.dates,
      });
      return;
    }

    // Если на графике «3 месяца» — переходим в конкретную выбранную неделю
    if (period === "quarter") {
      setSelectedPointIdx(null);
      setDrillDownScope({
        type: "week",
        title: `Неделя: ${pt.label}`,
        parentPeriodLabel: "3 месяца",
        dates: pt.dates,
      });
    }
  };

  // Вычисление данных для Кольца (либо за один выбранный день, либо за текущий диапазон)
  const donutData = useMemo(() => {
    if (singleDayDate) {
      // Аналитика за один конкретный день
      const dayCompleted = tasks.filter((t) => parseTaskCompletionDate(t) === singleDayDate).length;
      const dayActive = tasks.filter((t) => t.due_date === singleDayDate && t.status === "active").length;
      const dayOverdue = tasks.filter((t) => t.due_date === singleDayDate && t.status === "active" && singleDayDate < today).length;
      const dayOnTrack = Math.max(0, dayActive - dayOverdue);
      const total = dayCompleted + dayOnTrack + dayOverdue;

      const cPct = total > 0 ? Math.round((dayCompleted / total) * 100) : 0;
      const oPct = total > 0 ? Math.round((dayOnTrack / total) * 100) : 0;
      const odPct = total > 0 ? Math.max(0, 100 - cPct - oPct) : 0;

      const dObj = new Date(singleDayDate + "T00:00:00");
      const title = `${dObj.getDate()} ${MONTHS_SHORT[dObj.getMonth()]} (${WEEKDAYS_RU[dObj.getDay()]})`;

      return {
        isSingleDay: true,
        title,
        total,
        completed: dayCompleted,
        onTrack: dayOnTrack,
        overdue: dayOverdue,
        completedPct: cPct,
        onTrackPct: oPct,
        overduePct: odPct,
      };
    }

    // Аналитика за текущий отображаемый диапазон
    const totalComp = chartPoints.reduce((acc, p) => acc + p.completed, 0);
    const activeTasks = tasks.filter((t) => t.status === "active");
    const totalOd = activeTasks.filter((t) => t.due_date && t.due_date < today).length;
    const totalOt = Math.max(0, activeTasks.length - totalOd);
    const total = totalComp + totalOt + totalOd;

    const cPct = total > 0 ? Math.round((totalComp / total) * 100) : 0;
    const oPct = total > 0 ? Math.round((totalOt / total) * 100) : 0;
    const odPct = total > 0 ? Math.max(0, 100 - cPct - oPct) : 0;

    return {
      isSingleDay: false,
      title: "",
      total,
      completed: totalComp,
      onTrack: totalOt,
      overdue: totalOd,
      completedPct: cPct,
      onTrackPct: oPct,
      overduePct: odPct,
    };
  }, [singleDayDate, tasks, chartPoints, today]);

  const maxVal = Math.max(
    ...chartPoints.map((s) => Math.max(s.assigned, s.completed, s.active + s.completed, 1)),
    4,
  );

  const activePoint = selectedPointIdx !== null ? chartPoints[selectedPointIdx] : null;

  const headerTitle = drillDownScope ? drillDownScope.title : "Продуктивность";
  const periodSubtitle = drillDownScope
    ? `Детализация (${drillDownScope.parentPeriodLabel})`
    : period === "week"
      ? "За неделю"
      : period === "month"
        ? "За месяц"
        : period === "quarter"
          ? "За 3 месяца (по неделям)"
          : "За год (по месяцам)";

  return (
    <div className="bg-card rounded-2xl p-4 mb-4 border border-stroke/60 overflow-hidden">
      {/* Header: Title & View Switcher */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          {drillDownScope ? (
            <button
              type="button"
              onClick={() => {
                setDrillDownScope(null);
                setSelectedPointIdx(null);
                setSingleDayDate(null);
              }}
              className="tap-scale px-2 py-1 -ml-1 rounded-lg bg-card2 hover:bg-card2/80 text-sub hover:text-text flex items-center gap-1 text-[12px] font-medium border border-stroke/40"
            >
              <Icon name="chevron-left" size={14} />
              {drillDownScope.parentPeriodLabel}
            </button>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-green/15 flex items-center justify-center text-green">
              <Icon name="activity" size={15} />
            </div>
          )}

          <div>
            <h2 className="text-[15px] font-semibold text-text leading-tight">
              {headerTitle}
            </h2>
            <div className="text-[11px] text-sub">{periodSubtitle}</div>
          </div>
        </div>

        {/* 2-Segment Control: Кривая | Кольцо */}
        <div className="flex items-center bg-card2 p-0.5 rounded-xl border border-stroke/40">
          <button
            type="button"
            onClick={() => setChartType("line")}
            className={`tap-scale px-3 py-1 rounded-lg text-[12px] font-medium transition-all ${
              chartType === "line"
                ? "bg-card text-text shadow-sm"
                : "text-dim hover:text-sub"
            }`}
          >
            Кривая
          </button>
          <button
            type="button"
            onClick={() => setChartType("donut")}
            className={`tap-scale px-3 py-1 rounded-lg text-[12px] font-medium transition-all ${
              chartType === "donut"
                ? "bg-card text-text shadow-sm"
                : "text-dim hover:text-sub"
            }`}
          >
            Кольцо
          </button>
        </div>
      </div>

      {/* ── VIEW 1: SMOOTH SVG CURVE ── */}
      {chartType === "line" && (
        <div>
          <div className="h-[140px] w-full relative pt-2 pb-1">
            <svg
              className="w-full h-full overflow-visible"
              viewBox="0 0 320 100"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLOR_GREEN} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={COLOR_GREEN} stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              <line x1="0" y1="20" x2="320" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="55" x2="320" y2="55" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="90" x2="320" y2="90" stroke="rgba(255,255,255,0.08)" />

              {/* Render Area & Line */}
              {(() => {
                const len = chartPoints.length;
                if (len === 0) return null;

                const points = chartPoints.map((s, idx) => {
                  const x = len > 1 ? (idx / (len - 1)) * 300 + 10 : 160;
                  const y = 90 - (s.completed / maxVal) * 75;
                  return { x, y, val: s.completed };
                });

                // Smooth Bezier path
                let pathD = `M ${points[0].x} ${points[0].y}`;
                if (len === 1) {
                  pathD += ` L ${points[0].x + 1} ${points[0].y}`;
                } else {
                  for (let i = 0; i < len - 1; i++) {
                    const p0 = points[i];
                    const p1 = points[i + 1];
                    const cx = (p0.x + p1.x) / 2;
                    pathD += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
                  }
                }

                const areaD = `${pathD} L ${points[points.length - 1].x} 90 L ${points[0].x} 90 Z`;

                return (
                  <>
                    <path d={areaD} fill="url(#curveFill)" />
                    <path
                      d={pathD}
                      fill="none"
                      stroke={COLOR_GREEN}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    {points.map((p, idx) => (
                      <g key={idx}>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={selectedPointIdx === idx ? 5.5 : len > 15 ? 3 : 4}
                          fill={COLOR_GREEN}
                          stroke="#1A1A1A"
                          strokeWidth="2"
                          className="cursor-pointer transition-all"
                          onClick={() => handlePointClick(idx)}
                        />
                      </g>
                    ))}
                  </>
                );
              })()}
            </svg>
          </div>

          {/* 1. Weekday labels — Неделя (или drill-down неделя) */}
          {(period === "week" || drillDownScope?.type === "week") && (
            <div className="flex justify-between px-1 text-[10px] text-dim font-semibold">
              {chartPoints.map((st, i) => (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => handlePointClick(i)}
                  className={`transition-colors text-center ${
                    st.key === today ? "text-red font-bold" : selectedPointIdx === i ? "text-text font-bold" : "text-dim"
                  }`}
                >
                  {st.shortLabel}
                </button>
              ))}
            </div>
          )}

          {/* 2. Month Timeline — Месяц (1..сегодня или drill-down месяц) */}
          {((period === "month" && !drillDownScope) || drillDownScope?.type === "month") && (
            <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-dim font-medium">
              <span className="text-dim/80">{chartPoints[0]?.shortLabel}</span>
              <span className="text-text font-semibold px-2 py-0.5 bg-card2/80 rounded-md border border-stroke/30">
                {drillDownScope ? drillDownScope.title : MONTHS_NAMES_RU[now.getMonth()]}
              </span>
              <span className="text-red font-semibold">{chartPoints[chartPoints.length - 1]?.shortLabel}</span>
            </div>
          )}

          {/* 3. Quarter Timeline — 3 месяца (12 недель) */}
          {period === "quarter" && !drillDownScope && (
            <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-dim font-medium">
              <span>{MONTHS_NAMES_RU[(now.getMonth() - 2 + 12) % 12]}</span>
              <span>{MONTHS_NAMES_RU[(now.getMonth() - 1 + 12) % 12]}</span>
              <span className="text-text font-semibold">{MONTHS_NAMES_RU[now.getMonth()]}</span>
            </div>
          )}

          {/* 4. Year Timeline — Год (12 месяцев) */}
          {period === "year" && !drillDownScope && (
            <div className="flex justify-between px-1 pt-1 text-[10px] text-dim font-medium">
              {chartPoints.map((st, i) => (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => handlePointClick(i)}
                  className="hover:text-text transition-colors"
                >
                  {st.shortLabel}
                </button>
              ))}
            </div>
          )}

          {/* Bottom helper & Drill-down hint */}
          <div className="mt-3 pt-2.5 border-t border-stroke/40 flex items-center justify-between text-[12px]">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLOR_GREEN }} />
              <span className="text-sub">
                {drillDownScope
                  ? "Тапните день для кольца дня"
                  : period === "year"
                    ? "Тапните месяц для перехода"
                    : period === "quarter"
                      ? "Тапните неделю для перехода"
                      : "Тапните точку для кольца дня"}
              </span>
            </div>
            {activePoint ? (
              <span className="text-text font-medium">
                {activePoint.label}: {activePoint.completed} вып.
              </span>
            ) : (
              <span className="text-text font-medium">
                Всего: {donutData.completed} вып.
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── VIEW 2: 3-SEGMENT DONUT (ВЫПОЛНЕНО + В РАБОТЕ + ПРОСРОЧЕНО) ── */}
      {chartType === "donut" && (
        <div className="flex flex-col gap-3 py-1">
          {/* Day selection badge if drilled-down */}
          {donutData.isSingleDay && (
            <div className="flex items-center justify-between bg-card2/80 px-3 py-1.5 rounded-xl border border-stroke/40 text-[12px]">
              <span className="text-text font-semibold flex items-center gap-1.5">
                <Icon name="calendar" size={13} className="text-red" />
                {donutData.title}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSingleDayDate(null);
                  setSelectedPointIdx(null);
                }}
                className="text-dim hover:text-text font-medium text-[11px] underline"
              >
                Показать за весь период
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            {/* SVG Donut Chart with 3 colored arcs */}
            <div className="relative w-[104px] h-[104px] shrink-0">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                {/* Background Ring */}
                <path
                  className="text-card2"
                  strokeWidth="3.8"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />

                {donutData.total === 0 ? (
                  <path
                    className="text-dim/30"
                    strokeWidth="3.8"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                ) : (
                  <>
                    {/* 1. Completed Arc (Зеленый) */}
                    {donutData.completedPct > 0 && (
                      <path
                        stroke={COLOR_GREEN}
                        strokeDasharray={`${donutData.completedPct} ${100 - donutData.completedPct}`}
                        strokeDashoffset="0"
                        strokeWidth="3.8"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    )}

                    {/* 2. In-progress Arc (Синий) */}
                    {donutData.onTrackPct > 0 && (
                      <path
                        stroke={COLOR_BLUE}
                        strokeDasharray={`${donutData.onTrackPct} ${100 - donutData.onTrackPct}`}
                        strokeDashoffset={-donutData.completedPct}
                        strokeWidth="3.8"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    )}

                    {/* 3. Overdue Arc (Красный/Коралл) */}
                    {donutData.overduePct > 0 && (
                      <path
                        stroke={COLOR_CORAL}
                        strokeDasharray={`${donutData.overduePct} ${100 - donutData.overduePct}`}
                        strokeDashoffset={-(donutData.completedPct + donutData.onTrackPct)}
                        strokeWidth="3.8"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    )}
                  </>
                )}
              </svg>

              {/* В центре кружочка: общее число задач */}
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[20px] font-bold text-text leading-none">
                  {donutData.total}
                </span>
                <span className="text-[9px] text-dim font-medium mt-1">
                  всего задач
                </span>
              </div>
            </div>

            {/* Metrics Breakdown Grid */}
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div className="bg-card2/50 rounded-xl p-2.5 border border-stroke/30">
                <div className="flex items-center gap-1.5 text-green text-[11px] font-medium mb-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLOR_GREEN }} />
                  Выполнено
                </div>
                <div className="text-[16px] font-bold text-text">
                  {donutData.completed}{" "}
                  <span className="text-[11px] font-normal text-dim">({donutData.completedPct}%)</span>
                </div>
              </div>

              <div className="bg-card2/50 rounded-xl p-2.5 border border-stroke/30">
                <div className="flex items-center gap-1.5 text-blue text-[11px] font-medium mb-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLOR_BLUE }} />
                  В работе
                </div>
                <div className="text-[16px] font-bold text-text">
                  {donutData.onTrack}{" "}
                  <span className="text-[11px] font-normal text-dim">({donutData.onTrackPct}%)</span>
                </div>
              </div>

              <div className="bg-card2/50 rounded-xl p-2.5 border border-stroke/30 col-span-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-coral text-[11px] font-medium">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLOR_CORAL }} />
                  Просрочено
                </div>
                <div className="text-[14px] font-bold text-coral">
                  {donutData.overdue}{" "}
                  <span className="text-[11px] font-normal text-coral/80">({donutData.overduePct}%)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
