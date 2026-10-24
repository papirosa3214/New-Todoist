import { useEffect, useRef, useState } from "react";
import { hapticGrab, hapticDrop } from "./haptics";

// ═══════════ PULL-TO-REFRESH ═══════════
// Просьба Максима 26.08.2026: «потянул — обновил», как в обычных
// приложениях — вместо «выйти из раздела и зайти обратно», когда данные
// кажутся несвежими.
//
// Почему свой хук, а не готовая библиотека и не нативный UIRefreshControl:
// приложение живёт в WKWebView (Capacitor), у WebView нативного
// refresh-контрола для произвольного вложенного скроллера нет — а скролл
// здесь именно вложенный (Layout.tsx: документ заперт app-shell-locked,
// крутится внутренний flex-1 контейнер). Capacitor-плагины pull-to-refresh
// работают только с прокруткой самого WebView-документа — не наш случай.
//
// Механика — ровно та, что у системного:
//  - жест начинается ТОЛЬКО когда скроллер уже стоит на самом верху
//    (scrollTop <= 0); в любом другом положении палец прокручивает список
//    как обычно, хук не вмешивается вовсе;
//  - тянем вниз — индикатор выезжает с сопротивлением (расстояние делится,
//    как у резинки iOS: чем дальше тянешь, тем медленнее едет);
//  - дотянул до порога — hapticGrab (тот же «щелчок взятия», что у
//    перетаскивания) и стрелка доворачивается: «отпускай — обновлю»;
//  - отпустил за порогом — onRefresh() крутит спиннер, потом всё
//    сворачивается; отпустил раньше — просто сворачивается.
//
// preventDefault на touchmove обязателен, пока жест наш: без него WebView
// может начать собственный overscroll-bounce контейнера, и индикатор
// поедет вместе с резинкой контейнера двойным движением. Слушатель
// поэтому ставится с passive: false — но touchmove БЕЗ активного жеста
// выходит из обработчика первой же строкой, так что обычная прокрутка
// не теряет ни кадра.
const THRESHOLD = 70; // px индикатора, после которых отпускание обновляет
const MAX_PULL = 110; // дальше индикатор не едет, только резинка
const RESISTANCE = 2.2; // делитель пальцевого расстояния

export interface PullState {
  /** Насколько выехал индикатор, 0..MAX_PULL (px). */
  pull: number;
  /** Порог пройден — отпускание запустит обновление. */
  armed: boolean;
  /** onRefresh уже выполняется — крутим спиннер. */
  refreshing: boolean;
}

export function usePullToRefresh(
  scrollerRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
  enabled: boolean,
): PullState {
  const [state, setState] = useState<PullState>({
    pull: 0,
    armed: false,
    refreshing: false,
  });
  // Живые значения жеста — в ref, не в state: touchmove приходит десятки
  // раз в секунду, setState на каждый кадр и так нужен (индикатор едет),
  // но решения «жест активен/порог пройден» читаются синхронно.
  const gesture = useRef({ active: false, startY: 0, armed: false });
  const refreshingRef = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      // Начинать можно только с самого верха — иначе это обычный скролл.
      if (el.scrollTop > 0) return;
      gesture.current = {
        active: true,
        startY: e.touches[0].clientY,
        armed: false,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = gesture.current;
      if (!g.active || refreshingRef.current) return;
      const dy = e.touches[0].clientY - g.startY;
      if (dy <= 0) {
        // Палец пошёл вверх — это прокрутка вниз по списку, жест отменён.
        if (g.armed || dy < -4) g.active = false;
        setState((s) => (s.pull !== 0 ? { ...s, pull: 0, armed: false } : s));
        return;
      }
      // Скроллер успел уехать (например, инерция) — отдаём жест ему.
      if (el.scrollTop > 0) {
        g.active = false;
        setState((s) => (s.pull !== 0 ? { ...s, pull: 0, armed: false } : s));
        return;
      }
      e.preventDefault();
      const pull = Math.min(dy / RESISTANCE, MAX_PULL);
      const armed = pull >= THRESHOLD;
      if (armed && !g.armed) hapticGrab(); // порог пройден — «взял»
      g.armed = armed;
      setState({ pull, armed, refreshing: false });
    };

    const onTouchEnd = () => {
      const g = gesture.current;
      if (!g.active) return;
      g.active = false;
      if (g.armed && !refreshingRef.current) {
        refreshingRef.current = true;
        setState({ pull: THRESHOLD, armed: true, refreshing: true });
        hapticDrop();
        void onRefresh().finally(() => {
          refreshingRef.current = false;
          setState({ pull: 0, armed: false, refreshing: false });
        });
      } else {
        setState({ pull: 0, armed: false, refreshing: false });
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [scrollerRef, onRefresh, enabled]);

  return state;
}
