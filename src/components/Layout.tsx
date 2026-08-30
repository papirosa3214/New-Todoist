import { Outlet, useLocation, matchPath, useNavigate } from "react-router-dom";
import { BottomNav, SideNav, FAB, Icon } from "./UI";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { FanMenu, FAN_MENU_CONTENT_PADDING } from "./FanMenu";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "../api/auth";
import { useAppStore } from "../store";
import { useNotificationsSocket } from "../api/ws";
import { useLiveActivitySync } from "../lib/useLiveActivitySync";
import { useVisualViewportInset } from "../lib/useVisualViewportInset";
import { usePullToRefresh } from "../lib/usePullToRefresh";
import { useSwipeBack } from "../lib/useSwipeBack";
import { NAV_ITEMS } from "../lib/navItems";
import { warmUpWhisper } from "../lib/localAI";
import { flushArchiveQueue } from "../lib/dictationArchive";
import { useIsMobile, useDesktopPanelEligible } from "../lib/viewport";
import {
  useRealLocation,
  getOverlayState,
} from "../lib/backgroundLocationContext";

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
// /notes добавлен 26.08.2026: «Дневник» стал самостоятельным разделом
// веера, а не drill-down из Ежедневника. Только сам корень — /notes/:id
// остаётся вложенным экраном со своей кнопкой «Назад» и без навигации.
// /settings ИЗ СПИСКА УБРАН (26.08.2026). Он попал сюда, когда Настройки
// были пунктом веера. Теперь это строка внутри «Обзора», то есть обычный
// вложенный экран — Максим: «раз это у нас подпункт меню, убрать веер
// там». Заодно на нём заработал свайп назад: он включается ровно там, где
// навигации нет.
// /projects добавлен 26.08.2026 — стал пунктом веера вместо /inbox
// («Проекты» вели на переименованные Входящие, а настоящий экран проектов
// лежал в Настройках). Тогда же /inbox УДАЛЁН целиком — Максим: «зачем эти
// входящие нам нужны, они по сути часть ежедневника; из ежедневника я могу
// сделать всё, и входящие, и не входящие».
// 27.08.2026: список больше ни на что не влияет — панель висит на каждом
// экране, а какая вкладка подсвечена, решает сам BottomNav по своим
// NAV_ITEMS (components/UI.tsx). Оставлен как справка о том, какие пять
// маршрутов считаются вкладками.
const TAB_ROUTES = ["/projects", "/today", "/upcoming", "/overview", "/notes"];
void TAB_ROUTES;

// Переключатель нижней панели на мобильном — задача Максима 17.08.2026,
// «попробовать веер вместо горбика+FAB». "fan" — новый FanMenu.tsx
// (BottomNav и FAB не удалены, просто не рендерятся на мобильном, пока
// стоит "fan" — один флаг возвращает прежнее поведение). Десктоп
// (SideNav+FAB) эта задача не касалась, там всё как было.
const MOBILE_NAV_STYLE: "fan" | "tabbar" = "tabbar";

export function Layout() {
  // `loc` — location, которую видит этот Layout: на десктопе с открытой
  // панелью задачи это подменённый App.tsx location ФОНА (список), не
  // /task/:id — react-router подставляет его через <Routes location> выше
  // по дереву (см. lib/backgroundLocation.tsx), а Layout как раз рендерится
  // внутри этого дерева. Поэтому весь код ниже, завязанный на «какая сейчас
  // вкладка/таб» (hideNav, hideFAB, dueToday), продолжает работать НЕ
  // меняясь: он и раньше судил по location.pathname, а теперь получает
  // pathname списка позади панели вместо /task/:id — то есть ведёт себя
  // ровно так, как будто панели нет, что и требуется (нижняя/боковая
  // навигация не должна прятаться из-за открытой панели).
  const loc = useLocation();
  // Реальный (не подменённый) location — только для того, чтобы узнать,
  // что на САМОМ ДЕЛЕ открыт /task/:id с фоном, и нарисовать панель.
  const realLoc = useRealLocation();
  const isMobile = useIsMobile();
  const panelEligible = useDesktopPanelEligible();
  const overlayTaskId = matchPath(
    { path: "/task/:id", end: true },
    realLoc.pathname,
  )?.params.id;
  const hasBackground = !!getOverlayState(realLoc)?.backgroundLocation;
  const showTaskPanel =
    !isMobile && panelEligible && hasBackground && !!overlayTaskId;
  // Инсет экранной клавиатуры (--kb-inset на <html>) — см.
  // src/lib/useVisualViewportInset.ts за подробным «почему». Подключён
  // безусловно (не только для мобильной ветки ниже): на десктопе экранной
  // клавиатуры не бывает, но и вреда от подписки на несуществующее там
  // событие тоже нет — а один общий вызов на весь Layout проще, чем два
  // условных в двух разных return-ветках ниже.
  useVisualViewportInset();
  // Прогрев модели распознавания и досылка архива диктовок — при первом входе
  // в приложение под авторизацией. Жили в KeyboardProvider, пока тот
  // существовал (он оборачивал ровно этот Layout); с отключением своей
  // клавиатуры 20.08.2026 переехали сюда, чтобы не пропасть вместе с ней.
  // Прогрев обязан быть заранее: загрузка CoreML-модели занимает куда больше
  // тех трёх секунд, что плагин отводит на ожидание, и «ленивый» прогрев в
  // момент диктовки означал бы, что Whisper не успевает никогда. Досылка —
  // потому что .110 мог быть недоступен, когда запись делалась.
  useEffect(() => {
    warmUpWhisper();
    void flushArchiveQueue();
  }, []);
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
  // 27.08.2026, требование владельца: «панель теперь должна находиться в
  // каждом окне». Раньше она жила только на пяти таб-экранах (TAB_ROUTES), а
  // на любом drill-down (задача, форма, настройки, агенты, проект) исчезала —
  // и переход между разделами оттуда требовал сначала уйти назад. Теперь
  // панель показывается везде внутри Layout; сам список TAB_ROUTES остаётся
  // нужен ниже — по нему решается судьба кнопки «+», а не панели.
  //
  // 28.08.2026 у правила «панель в каждом окне» появилось РОВНО ОДНО
  // исключение — экран чата. Владелец: «вот это окно ввода нужно всё-таки
  // приземлить, прилепить — на замену этой менюшке с плюсиком; я открываю
  // чатик, и у меня вся страничка исключительно чатика, потому что это
  // единственное окно, где это уместно». То есть панель тут не «спрятана
  // за ненадобностью», а ЗАМЕНЕНА другим постоянным низом — строкой ввода
  // (ChatComposer, position:fixed). Две прибитые к низу полосы одна над
  // другой не уживаются: вместе они съедали бы четверть экрана и ловили
  // тапы друг у друга.
  //
  // Выход с экрана поэтому переехал в шапку — кнопка «назад» в «Обзор»
  // (ChatScreen.tsx). Убирать это исключение можно только вместе со
  // строкой ввода, иначе с /chat станет некуда уйти.
  const hideNav = !!matchPath({ path: "/chat", end: true }, loc.pathname);
  // Плюс к этому: на доске «Сегодня» и на доске «Входящие» кнопка «+»
  // прячется, потому что там под каждой колонкой уже есть пилюля
  // «Добавить задачу» (TodayScreen.tsx — footer колонки «Сегодня»;
  // InboxScreen.tsx — footer каждой колонки-проекта и «Без проекта») — два
  // способа добавить задачу в одном экране владельцу не нужны. Правило
  // именно «есть замена — прячем», а не «доска — прячем»: список на обоих
  // экранах пилюль не показывает, так что там кнопка остаётся на месте.
  const todayLayout = useAppStore((s) => s.taskLayout.today);
  // Ветка про доску Входящих убрана вместе с самим экраном (26.08.2026):
  // осталась только доска «Сегодня».
  const fabReplacedByPill =
    todayLayout === "board" &&
    !!matchPath({ path: "/today", end: true }, loc.pathname);
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
  // Плюс открытая панель задачи (десктоп, showTaskPanel): FAB — `fixed
  // right-[18px]` от ОКНА (UI.tsx), то есть ровно там, где садится правый
  // край TaskDetailPanel — без этого условия кнопка «+» плавала бы поверх
  // текста задачи.
  const hideFAB =
    hideNav || fabReplacedByPill || fabHiddenOnOverview || showTaskPanel;
  const { data: currentUser } = useCurrentUser();
  useNotificationsSocket(!!currentUser);
  // Островок ведёт себя как часть приложения, а не как функция экрана задачи:
  // пока агент работает, прогресс висит в Dynamic Island сам, из любого
  // раздела. Здесь же он и гаснет, когда работа кончилась.
  useLiveActivitySync(!!currentUser);

  // ── Pull-to-refresh (Максим 26.08.2026: «потянул — обновил», WS-инвали-
  // дация иногда не долетает, приходилось выходить-заходить в раздел) ──
  // Здесь, на общем скроллере Layout, а не по экранам: жест должен работать
  // одинаково во всех разделах. Обновление — invalidate ВСЕХ активных
  // React Query-запросов: у каждого экрана свои ключи (tasks, projects,
  // notifications…), перечислять их здесь означало бы чинить этот список
  // при каждом новом экране. refetchType: "active" — дёргаются только
  // запросы, на которые сейчас реально смотрит экран.
  const qc = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh(
    scrollerRef,
    () => qc.invalidateQueries({ refetchType: "active" }),
    isMobile, // на десктопе жеста «потянуть» нет — там мышь и live-WS
  );
  // Свайп «назад» — только на вложенных экранах: из корневого раздела
  // уходить некуда, а жест там дрался бы с горизонтальными свайпами внутри
  // контента (листание дней, свайп строки задачи).
  //
  // Условием раньше было hideNav («панель спрятана — значит вложенный
  // экран»). 27.08.2026 панель показывается ВЕЗДЕ, hideNav стал константой
  // false — и свайп молча выключился на всём приложении (владелец: «свайпы
  // ты убрал»). Теперь условие спрашивает прямо то, что и имелось в виду:
  // текущий путь — не корневая вкладка.
  const navigate = useNavigate();
  const isRootTab = NAV_ITEMS.some((item) => item.path === loc.pathname);
  useSwipeBack(() => {
    // Та же защита, что у стрелки в шапке (ScreenHeader): если экран открыт
    // по прямой ссылке и истории за ним нет, шаг назад выкинул бы из
    // приложения (в вебе — на пустую вкладку). Уходим в «Обзор».
    if (window.history.length > 1) navigate(-1);
    else navigate("/overview");
  }, !isRootTab);

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
      <>
        <div className="h-[100dvh] overflow-hidden flex flex-col bg-bg">
          <div
            ref={scrollerRef}
            className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain"
          >
            {/* ── Индикатор pull-to-refresh ──
              Едет из-за верхней кромки вместе с пальцем (высота = pull),
              стрелка по мере натяжения доворачивается на 180° и после
              порога меняет цвет на акцент («отпускай»); после отпускания
              стрелку сменяет системный спиннер. transition только когда
              жеста нет (pull едет с пальцем 1:1, анимировать нечего) —
              чтобы сворачивание после отпускания было плавным. */}
            <div
              aria-hidden={pull.pull === 0}
              className="pointer-events-none sticky top-0 z-20 -mb-px flex items-end justify-center overflow-hidden"
              style={{
                height: pull.pull,
                transition:
                  pull.refreshing || pull.pull === 0
                    ? "height 0.25s ease"
                    : "none",
              }}
            >
              <div className="pb-2">
                {pull.refreshing ? (
                  <div className="h-5 w-5 rounded-full border-2 border-stroke border-t-red animate-spin" />
                ) : (
                  <Icon
                    name="arrowDown"
                    size={18}
                    className={pull.armed ? "text-red" : "text-dim"}
                    style={{
                      transform: pull.armed ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.2s ease, color 0.2s ease",
                    }}
                  />
                )}
              </div>
            </div>
            {/* Контент за пальцем НЕ едет (26.08.2026). Сначала он ехал
              через translateX — красиво, но шапка внутри прибита к экрану
              (position:fixed), а fixed внутри элемента с transform
              привязывается к ЭТОМУ элементу, а не к окну. Итог: заголовок
              ездил вместе с контентом и мог остаться прижатым к краю —
              Максим: «дневник название всё время елозит куда-то и к левому
              краю прицеплено». Чинить это вычитанием сдвига в замере
              шапки значило бы лечить симптом на каждом кадре жеста.
              Ощущение жеста несёт сама смена экрана. */}
            <div
              className={isFan ? undefined : "pb-content-safe"}
              style={
                isFan ? { paddingBottom: FAN_MENU_CONTENT_PADDING } : undefined
              }
            >
              <Outlet />
            </div>
          </div>
          {!hideNav && isFan && <FanMenu />}
          {!hideNav && !isFan && <BottomNav />}
          {/* Отдельной плавающей кнопки на мобильном больше нет: её действие
            переехало в красный круг внутри самой панели (27.08.2026,
            владелец: «кружочек этот красный вместо вот этих всяких плюсиков
            левых наверху»). У веера своя кнопка, там FAB и не рисовался. */}
        </div>
      </>
    );
  }

  /* ── Desktop: sidebar + content(+panel), no phone frame ──
     Replaces the old "shrink the whole app into a 390×844 phone mockup and
     float it in the middle of the browser window" staging. Real desktop
     layout: SideNav (UI.tsx) takes BottomNav's job — same four destinations,
     same `hideNav` condition, just a column instead of a row.
     Content width — REVISED 25.08.2026, owner: «это разве десктоп, надо как
     все такие приложения сделать, а не мобильная версия с адаптацией» →
     «сделай как Linear и Todoist, ты же знаешь как они выглядят». That
     directly overturns the older brief quoted in git history here
     ("не делай навороченный десктопный дашборд", which had capped this at a
     narrow single 640px column) — 640px read as an enlarged phone screen
     with a lot of dead margin either side, not an intentional desktop view.
     Now: a wider list (880px) and, on genuinely wide desktops, a
     TaskDetailPanel.tsx column that opens a task ALONGSIDE the list instead
     of navigating away — Todoist/Linear's master-detail pattern. Below
     `useDesktopPanelEligible`'s 1280px floor, or on mobile, a task click
     stays a full navigation (useOpenTask.ts) — three fixed-width columns
     (nav + list + panel) don't fit readably any narrower.
     Same definite-height / `min-*-0` / nested-scroll shape as the mobile
     branch above, just row-direction: the wrapper's `h-[100dvh]` is the
     definite size flex `stretch` (the default for row-direction children)
     hands the content column, so its own `overflow-y-auto` genuinely
     contains scroll; `min-w-0` is this row's version of the mobile branch's
     `min-h-0` — a flex item's automatic minimum size is its content size on
     the *main* axis unless told otherwise, and here the main axis is width.
     `max-w-[880px] mx-auto` is a ceiling, not a fixed width: when the panel
     is open, this column already sits in a narrower flex-1 slot (nav 240 +
     panel 460 eaten out of the viewport first), so it simply fills that —
     no separate "panel open" width variant needed.
     No `transform` needed for FAB's `position: fixed` (unlike the old phone
     frame, which needed one as a containing-block trick): this shell already
     *is* the full viewport, so plain `fixed` already lands where it should. */
  return (
    <>
      <div className="h-[100dvh] overflow-hidden flex bg-bg">
        {!hideNav && <SideNav />}
        <div className="flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden overscroll-y-contain">
          <div className="max-w-[880px] mx-auto pb-bottom-safe">
            <Outlet />
          </div>
        </div>
        {showTaskPanel && overlayTaskId && (
          <TaskDetailPanel location={realLoc} />
        )}
        {!hideFAB && (
          <FAB
            dueToday={loc.pathname === "/today"}
            onLongPress={
              loc.pathname === "/projects"
                ? () => navigate("/projects?create=1")
                : loc.pathname === "/notes"
                  ? () => navigate("/notes?create=1")
                  : undefined
            }
          />
        )}
      </div>
    </>
  );
}
