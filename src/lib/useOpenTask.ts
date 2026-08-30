import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useIsMobile, useDesktopPanelEligible } from "./viewport";
import { useRealLocation, getOverlayState } from "./backgroundLocationContext";

// Единая точка «открыть задачу» для списков (InboxScreen/TodayScreen/
// UpcomingScreen — TaskBoard, UpcomingCalendar, DayHours, простые строки).
// На мобильном и на узком десктопе (<1280px) — обычная навигация, как было
// всегда. На широком десктопе — тот же /task/:id, но с
// state.backgroundLocation, чтобы Layout.tsx нарисовал TaskDetailPanel
// поверх списка вместо перехода на отдельный экран (см.
// lib/backgroundLocation.tsx за тем, как это читается назад).
//
// Второй клик по другой задаче ПОКА панель уже открыта не должен копить
// историю «список → задача A → задача B → …» — иначе «назад» из задачи B
// вёл бы на задачу A, а не сразу на список. Поэтому: если сейчас уже
// показываем панель (у текущего location есть backgroundLocation), новая
// запись подменяет (`replace`) её же, унаследовав тот же самый background;
// если панели ещё нет — обычный push с background = список, который видим
// прямо сейчас.
//
// Важно: location берётся через useRealLocation(), а не голый useLocation().
// Этот хук вызывается из InboxScreen/TodayScreen/UpcomingScreen — а они
// сами рендерятся ФОНОМ, внутри <Routes location={background}> в App.tsx
// (см. lib/backgroundLocation.tsx). Их собственный useLocation() поэтому
// всегда возвращает подменённый (фоновый) location, на котором
// state.backgroundLocation просто неоткуда взяться — с ним `replace`
// всегда читался бы как false, и второй клик копил бы историю вместо
// подмены (пойман живьём на 1440px: два клика подряд → «назад» вёл на
// первую задачу, а не сразу на список).
export function useOpenTask() {
  const navigate = useNavigate();
  const location = useRealLocation();
  const isMobile = useIsMobile();
  const panelEligible = useDesktopPanelEligible();

  return useCallback(
    (id: string) => {
      if (isMobile || !panelEligible) {
        navigate(`/task/${id}`);
        return;
      }
      const overlay = getOverlayState(location);
      navigate(`/task/${id}`, {
        state: { backgroundLocation: overlay?.backgroundLocation ?? location },
        replace: !!overlay?.backgroundLocation,
      });
    },
    [navigate, location, isMobile, panelEligible],
  );
}
