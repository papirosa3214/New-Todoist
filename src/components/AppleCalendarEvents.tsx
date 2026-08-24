import { useEffect, useState } from "react";
import { AppleIntegrations, type CalendarEvent } from "../lib/appleIntegrations";
import { Icon } from "./UI";

interface Props {
  dateStr: string; // "YYYY-MM-DD"
  className?: string;
}

export function AppleCalendarEvents({ dateStr, className = "" }: Props) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    if (!AppleIntegrations.isAvailable()) return;

    let calIds: string[] | undefined = undefined;
    try {
      const stored = localStorage.getItem("apple_calendar_ids");
      if (stored) calIds = JSON.parse(stored);
    } catch {
      // ignore
    }

    const start = `${dateStr}T00:00:00`;
    const end = `${dateStr}T23:59:59`;

    AppleIntegrations.getEvents(start, end, calIds).then(setEvents);
  }, [dateStr]);

  if (!events || events.length === 0) return null;

  return (
    <div className={`space-y-1.5 ${className}`}>
      {events.map((ev) => {
        const startTime = ev.allDay
          ? "Весь день"
          : ev.startDate.split("T")[1]?.slice(0, 5) || "";
        const endTime =
          !ev.allDay && ev.endDate ? ` - ${ev.endDate.split("T")[1]?.slice(0, 5) || ""}` : "";

        return (
          <div
            key={ev.id}
            onClick={() => {
              if (typeof window !== "undefined" && (window as any).Capacitor) {
                import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
                  Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                });
              }
            }}
            className="flex items-start gap-2.5 px-3 py-2 rounded-xl bg-card border border-stroke/40 text-xs shadow-xs transition-transform active:scale-[0.98] cursor-pointer"
          >
            <div
              className="w-1.5 h-full min-h-[28px] rounded-full shrink-0"
              style={{ backgroundColor: ev.calendarColor || "#3B82F6" }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <span className="font-medium text-text truncate">{ev.title}</span>
                <span className="text-[10px] text-dim shrink-0 flex items-center gap-1">
                  <Icon name="calendar" size={11} className="text-sub" />
                  {ev.calendarTitle}
                </span>
              </div>
              <div className="text-[11px] text-sub mt-0.5">
                {startTime}
                {endTime}
                {ev.location && ` · ${ev.location}`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
