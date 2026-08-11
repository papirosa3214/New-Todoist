import { Outlet, useLocation, matchPath } from "react-router-dom";
import { StatusBar, BottomNav, FAB, Panel } from "./UI";
import { useEffect, useLayoutEffect, useState } from "react";
import { useCurrentUser } from "../api/auth";
import { useAppStore } from "../store";
import { useNotificationsSocket } from "../api/ws";

// Bottom nav + FAB belong only to the app's four top-level tab screens —
// the ones BottomNav itself renders a tab for (see NAV_ITEMS in UI.tsx) and
// the only ones mockup-reference/index.html shows a tabbar/fab on (see
// `.tabbar`/`.fab` in the "ЭКРАН 1/7/4·6/8" sections there). Every other
// route reachable through this Layout — task detail, task new/edit,
// settings, notifications, agents, projects list, project detail, search —
// is a "drill-down" screen with its own compact header and back/close
// button, and never shows nav or FAB in the mockup either.
//
// This used to be a blocklist of pathname *prefixes* (HIDE_NAV), checked
// with `startsWith`. That shape is unreliable in two directions at once:
//   - under-matches nested routes that don't share the listed prefix, e.g.
//     "/task/:id/edit" and "/task/:id" don't start with "/task/new", so both
//     leaked nav+FAB over their forms/cards (confirmed live: FAB physically
//     overlapped the "+ новая" label-create button on the edit screen);
//     "/settings" wasn't listed at all, so nav (not just FAB) leaked there.
//   - over-matches by accident, e.g. "/projects" as a prefix happens to also
//     swallow "/projects/:id" — correct here, but only by coincidence, not
//     because the code expressed that intent anywhere.
// An *allowlist* of the real route patterns (matched via react-router's own
// matchPath, not string comparison) can only be wrong by omission, and the
// four entries below are exhaustive by construction — every other screen in
// App.tsx is deliberately absent.
const TAB_ROUTES = ["/inbox", "/today", "/upcoming", "/overview"];

function isTabRoute(pathname: string) {
  return TAB_ROUTES.some((path) => matchPath({ path, end: true }, pathname));
}

function useIsMobile() {
  const [m, setM] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const onResize = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return m;
}

export function Layout() {
  const loc = useLocation();
  const isMobile = useIsMobile();
  // Тело документа не должно прокручиваться на мобильном — иначе браузер
  // выкатывает свою адресную строку/панель поверх приложения (жалоба
  // владельца 2026-08-11: на «Входящих» контент помещается в экран и
  // браузерной обвязки не видно, на остальных вкладках контент длиннее,
  // начинается прокрутка ТЕЛА документа — и хрень появляется). Класс
  // ставится/снимается на <html>, CSS-правила — index.css
  // (html.app-shell-locked). useLayoutEffect, не useEffect: класс должен
  // попасть на <html> ДО того, как браузер отрисует кадр — иначе будет
  // видимый кадр со старым overflow (документ прокрутится/дёрнется на
  // первый рендер каждого захода в Layout). Только для мобильной ветки:
  // десктопная рамка уже сама себя ограничивает высотой 844px и никогда не
  // полагалась на прокрутку body, трогать её поведение незачем.
  useLayoutEffect(() => {
    if (!isMobile) return;
    document.documentElement.classList.add("app-shell-locked");
    return () => {
      document.documentElement.classList.remove("app-shell-locked");
    };
  }, [isMobile]);
  // FAB never appears without nav (or vice versa) in the mockup — the four
  // tab screens show both together, every drill-down screen shows neither —
  // so one boolean drives both instead of carrying a second, independently
  // driftable condition (the old `|| pathname.startsWith("/settings")` was
  // exactly that: a patch for FAB alone that left nav itself still showing
  // on /settings).
  const hideNav = !isTabRoute(loc.pathname);
  // Плюс к этому: на доске «Сегодня» и на доске «Входящие» кнопка «+»
  // прячется, потому что там под каждой колонкой уже есть пилюля
  // «Добавить задачу» (TodayScreen.tsx — footer колонки «Сегодня»;
  // InboxScreen.tsx — footer каждой колонки-проекта и «Без проекта») — два
  // способа добавить задачу в одном экране владельцу не нужны. Правило
  // именно «есть замена — прячем», а не «доска — прячем»: список на обоих
  // экранах пилюль не показывает, так что там кнопка остаётся на месте.
  const todayLayout = useAppStore((s) => s.taskLayout.today);
  const inboxLayout = useAppStore((s) => s.taskLayout.inbox);
  const fabReplacedByPill =
    (todayLayout === "board" &&
      !!matchPath({ path: "/today", end: true }, loc.pathname)) ||
    (inboxLayout === "board" &&
      !!matchPath({ path: "/inbox", end: true }, loc.pathname));
  const hideFAB = hideNav || fabReplacedByPill;
  const { data: currentUser } = useCurrentUser();
  useNotificationsSocket(!!currentUser);

  /* ── Mobile: full-viewport, no frame ──
     2026-08-11: this used to be `min-h-[100dvh]` with NO nested overflow
     container — document itself scrolled. That was a deliberate workaround
     at the time (see git history) for a real failure mode: a flex column
     whose height comes only from `min-height` does NOT reliably cap a
     `flex-1 overflow-y-auto` child, so the column grew past the viewport
     and the document scrolled anyway. But letting the *document* scroll is
     exactly what makes mobile browsers pop out their address bar/toolbar
     chrome on every tab whose content is taller than one screen — owner-
     reported symptom: "Входящие" fits in one screen and looks clean, every
     other tab is longer, starts a document scroll, and the browser chrome
     appears.
     Fix: give this wrapper a *definite* height (`h-[100dvh]`, not
     `min-h-*`) instead — that's the one change the old comment's own
     diagnosis says should have capped the child correctly — and move the
     scroll into a single nested container, same shape as the desktop frame
     below (`flex-1 overflow-y-auto`) which never had this bug precisely
     because it already had a definite `h-[844px]`. `min-h-0` on the nested
     scroller overrides the flex default `min-height: auto`, which is the
     other half of the classic "flex column child won't actually scroll"
     trap (a flex item's automatic minimum size is its content size unless
     told otherwise, and that alone can stop `overflow-y-auto` from ever
     kicking in even with a definite height on the parent).
     `html.app-shell-locked` (index.css, toggled by the effect above) is
     what actually stops the document from scrolling — it overrides body's
     baseline `min-height: 100vh` and fixes both html/body to `100dvh` with
     `overflow: hidden`. Doing it there (not here) keeps the lock scoped to
     while this Layout is mounted, so /login and /register — which render
     outside Layout entirely and still rely on ordinary document scroll for
     their own `min-h-[100dvh]` form — are untouched.
     BottomNav/FAB stay `position: fixed` (UI.tsx) and this wrapper has no
     `transform`, so they still pin to the real viewport, not to this div —
     unaffected by any of the above. */
  if (isMobile) {
    return (
      <div className="h-[100dvh] overflow-hidden flex flex-col bg-bg">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain">
          <div className="pb-content-safe">
            <Outlet />
          </div>
        </div>
        {!hideNav && <BottomNav />}
        {!hideFAB && <FAB />}
      </div>
    );
  }

  /* ── Desktop: phone frame + panel ──
     This frame has an explicit h-[844px] (a definite height, unlike the
     mobile branch's min-h-only wrapper), so its nested `overflow-y-auto`
     genuinely contains scroll — that part was never broken. What it does
     need is `transform` on the frame: that's what makes it the containing
     block for `position: fixed` descendants (BottomNav, FAB). Without it,
     "fixed" pins to the real browser viewport and the nav/FAB fly out of
     the little phone mockup instead of staying inside it. */
  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center p-4 xl:p-8">
      <div className="flex gap-8 items-start">
        <div
          className="relative w-[390px] h-[844px] bg-bg rounded-[44px] border border-[#2a2a2a] shadow-[0_0_80px_rgba(0,0,0,.6)] overflow-hidden flex flex-col shrink-0"
          style={{ transform: "translateZ(0)" }}
        >
          <StatusBar />
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="pb-content-safe">
              <Outlet />
            </div>
          </div>
          {!hideNav && <BottomNav />}
          {!hideFAB && <FAB />}
        </div>
        <Panel />
      </div>
    </div>
  );
}
