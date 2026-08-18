import { Outlet, useLocation, matchPath } from "react-router-dom";
import { BottomNav, SideNav, FAB, Panel } from "./UI";
import { FanMenu, FAN_MENU_CONTENT_PADDING } from "./FanMenu";
import { useEffect, useLayoutEffect, useState } from "react";
import { useCurrentUser } from "../api/auth";
import { useAppStore } from "../store";
import { useNotificationsSocket } from "../api/ws";
import { useVisualViewportInset } from "../lib/useVisualViewportInset";

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

// Переключатель нижней панели на мобильном — задача Максима 17.08.2026,
// «попробовать веер вместо горбика+FAB». "fan" — новый FanMenu.tsx
// (BottomNav и FAB не удалены, просто не рендерятся на мобильном, пока
// стоит "fan" — один флаг возвращает прежнее поведение). Десктоп
// (SideNav+FAB) эта задача не касалась, там всё как было.
const MOBILE_NAV_STYLE: "fan" | "tabbar" = "fan";

function isTabRoute(pathname: string) {
  return TAB_ROUTES.some((path) => matchPath({ path, end: true }, pathname));
}

// Брейкпоинт — Tailwind `lg` (1024px), не `md` (768px, старое значение
// здесь). Ниже 1024 остаётся мобильная раскладка (single-column, полная
// ширина вьюпорта) — это осознанно шире, чем «телефон», и накрывает узкие
// ноутбучные окна/таблеты в портретной ориентации: до этой правки такое
// окно попадало в старую desktop-ветку и получало 390px рамку с мёртвым
// полем вокруг — то есть уже тогда фактически показывало «мобильный» вид,
// просто через фейковую рамку вместо честной полноширинной раскладки.
// Приложение мобильное по духу (см. задание), поэтому граница поставлена
// консервативно: только экраны, где реально помещается боковая колонка
// навигации + читаемая колонка контента (см. desktop-ветку ниже), получают
// десктопный вид.
function useIsMobile() {
  const [m, setM] = useState(
    typeof window !== "undefined" ? window.innerWidth < 1024 : false,
  );
  useEffect(() => {
    const onResize = () => setM(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return m;
}

export function Layout() {
  const loc = useLocation();
  const isMobile = useIsMobile();
  // Инсет экранной клавиатуры (--kb-inset на <html>) — см.
  // src/lib/useVisualViewportInset.ts за подробным «почему». Подключён
  // безусловно (не только для мобильной ветки ниже): на десктопе экранной
  // клавиатуры не бывает, но и вреда от подписки на несуществующее там
  // событие тоже нет — а один общий вызов на весь Layout проще, чем два
  // условных в двух разных return-ветках ниже.
  useVisualViewportInset();
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
  // desktop-ветка ниже сама себе ставит явную h-[100dvh] + overflow-hidden
  // на корневой обёртке (тот же приём, что и здесь, просто без класса на
  // <html>) и держит прокрутку внутри одного вложенного контейнера — она
  // никогда не полагалась на прокрутку body, трогать её поведение незачем.
  // Мобильному браузеру этот трюк ещё и нужнее: только там прокрутка body
  // выкатывает адресную строку, у десктопных браузеров такой панели нет.
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
  // «Обзор» — сводный экран (поиск, свои проекты, «ждут вас»), а не список
  // задач: задачу заводят там, где её потом видно — на «Входящих» или
  // «Сегодня». Поэтому кнопки «+» здесь нет вообще, в отличие от случая
  // выше — там она не исчезает, а заменяется пилюлей под колонкой.
  // Просьба Максима 14.08.2026. Нижняя навигация при этом остаётся:
  // «Обзор» — полноценный таб-экран.
  const fabHiddenOnOverview = !!matchPath(
    { path: "/overview", end: true },
    loc.pathname,
  );
  const hideFAB = hideNav || fabReplacedByPill || fabHiddenOnOverview;
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
     scroll into a single nested container, same shape the desktop branch
     below uses too (`flex-1 overflow-y-auto` off its own definite
     `h-[100dvh]` wrapper) for the same reason. `min-h-0` on the nested
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
    const isFan = MOBILE_NAV_STYLE === "fan";
    return (
      <div className="h-[100dvh] overflow-hidden flex flex-col bg-bg">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain">
          <div
            className={isFan ? undefined : "pb-content-safe"}
            style={
              isFan ? { paddingBottom: FAN_MENU_CONTENT_PADDING } : undefined
            }
          >
            <Outlet />
          </div>
        </div>
        {!hideNav && isFan && <FanMenu showAdd={!hideFAB} />}
        {!hideNav && !isFan && <BottomNav />}
        {!hideFAB && !isFan && <FAB dueToday={loc.pathname === "/today"} />}
      </div>
    );
  }

  /* ── Desktop: sidebar + content, no phone frame ──
     Replaces the old "shrink the whole app into a 390×844 phone mockup and
     float it in the middle of the browser window" staging. Real desktop
     layout instead: SideNav (UI.tsx) takes BottomNav's job — same four
     destinations, same `hideNav` condition, just a column instead of a row
     — and the content gets a `max-w`, not an edge-to-edge stretch: every
     screen under this Layout (list rows, form fields, compact drill-down
     headers) was built at 390px reference width, and letting rows go
     arbitrarily wide on a 2000px monitor would spread icon/label/chevron
     across mostly empty space, not show "more". 640px keeps it a single
     narrow column — wider than the phone, nowhere near a multi-pane
     dashboard, per the brief ("не делай навороченный десктопный дашборд").
     Same definite-height / `min-*-0` / nested-scroll shape as the mobile
     branch above, just row-direction: the wrapper's `h-[100dvh]` is the
     definite size flex `stretch` (the default for row-direction children)
     hands the content column, so its own `overflow-y-auto` genuinely
     contains scroll; `min-w-0` is this row's version of the mobile branch's
     `min-h-0` — a flex item's automatic minimum size is its content size on
     the *main* axis unless told otherwise, and here the main axis is width.
     No `transform` needed for FAB's `position: fixed` (unlike the old phone
     frame, which needed one as a containing-block trick): this shell already
     *is* the full viewport, so plain `fixed` already lands where it should. */
  return (
    <div className="h-[100dvh] overflow-hidden flex bg-bg">
      {!hideNav && <SideNav />}
      <div className="flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden overscroll-y-contain">
        <div className="max-w-[640px] mx-auto pb-bottom-safe">
          <Outlet />
        </div>
      </div>
      {!hideFAB && <FAB dueToday={loc.pathname === "/today"} />}
      <Panel />
    </div>
  );
}
