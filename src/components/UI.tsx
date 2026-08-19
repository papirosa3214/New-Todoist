import { useLocation, useNavigate } from "react-router-dom";
import {
  Children,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Clock,
  Calendar,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Cloud,
  Crown,
  Ellipsis,
  EllipsisVertical,
  Eye,
  Filter,
  Flag,
  GripVertical,
  Hash,
  Home,
  Image,
  Inbox,
  Info,
  LayoutGrid,
  Link,
  Lock,
  Mail,
  MapPin,
  Menu,
  Mic,
  Paperclip,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Shield,
  Sparkles,
  Star,
  Tag,
  Trash2,
  User,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTasks } from "../api/tasks";
import { API_BASE_URL } from "../api/client";
import { todayStr, formatRelativeTime } from "../lib/date";
import { getErrorMessage } from "../lib/errors";
import type { ApiTask } from "../api/types";
import { AnimatedTabBar, type TabItem } from "./AnimatedTabBar";
import type { BottomSheetDragProps } from "../lib/useBottomSheet";
import { NAV_ITEMS } from "../lib/navItems";

// ═══════════ ICON SET (Lucide) ═══════════
// База набора — Lucide (lucide-react): единая сетка 24×24, единая толщина
// обводки 1.5 (задаётся ниже пропсом, у Lucide по умолчанию 2). Ключи —
// прежние «наши» имена, под них заточены ~170 вызовов <Icon name="..."/>
// по всему проекту, поэтому сам компонент Icon снаружи не поменялся —
// поменялось только то, чем он рисует.
//
// Раньше "calendar" и "calendarSmall" были одним и тем же попиксельно
// нарисованным значком — из-за этого вкладки «Сегодня» и «Предстоящее»
// в нижнем меню выглядели близнецами. Теперь это два разных компонента
// Lucide, как и в mockup-reference (data-i="cal" vs data-i="calGrid"):
// обычный календарь и календарь с сеткой дней. "calendarSmall" (CalendarDays,
// «сетка дней») остался у «Предстоящего» — это ровно calGrid из
// mockup-reference. У «Сегодня» вместо "calendar" (простой лист календаря)
// теперь отдельный ключ "calendarCheck" (CalendarCheck, «календарь с
// галочкой») — владелец 2026-08-11: «у нас всё равно два календаря
// одинаковых, подбери какую-нибудь другую». "calendar" НЕ тронут и не
// переиспользован — на нём завязаны другие ~170 вызовов <Icon
// name="calendar"/> по проекту (даты задач и т.п.), это отдельный новый
// ключ только для нижнего меню.
//
// Кастомный (не-Lucide) рисунок остаётся только один — многоцветный логотип
// Google чуть ниже в самом компоненте Icon: в Lucide нет цветных брендовых
// иконок, а перекрашивать чужой лого в один цвет неверно.
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  calendar: Calendar,
  calendarCheck: CalendarCheck,
  calendarSmall: CalendarDays,
  // Час начала и длительность задачи (TimeField, 18.08.2026) — под
  // календарную развёртку раздела «День».
  clock: Clock,
  home: Home,
  tag: Tag,
  hash: Hash,
  flag: Flag,
  flagSmall: Flag,
  dots: EllipsisVertical,
  dotsH: Ellipsis,
  plus: Plus,
  check: Check,
  chevron: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronDown: ChevronDown,
  filter: Filter,
  close: X,
  x: X,
  search: Search,
  bell: Bell,
  bellSlash: BellOff,
  settings: Settings,
  gear: Settings,
  mail: Mail,
  lock: Lock,
  eye: Eye,
  person: User,
  crown: Crown,
  bot: Bot,
  list: Menu,
  grid: LayoutGrid,
  activity: Activity,
  star: Star,
  cloud: Cloud,
  shield: Shield,
  play: Play,
  link: Link,
  share: Share2,
  trash: Trash2,
  edit: Pencil,
  info: Info,
  moon: Moon,
  sync: RefreshCw,
  zap: Zap,
  image: Image,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  pin: MapPin,
  sparkles: Sparkles,
  // Доска задач (TaskBoard.tsx) — хендл ручного перетаскивания карточки.
  grip: GripVertical,
  // Кнопка микрофона (TaskFormScreen) — запись голоса → свой ASR.
  mic: Mic,
  // Вложения комментариев: кнопка «приложить файл» и строка документа в
  // ленте (AttachmentView.tsx).
  paperclip: Paperclip,
  // Полый кружок-маркер задачи в плашке DayHours (19.08.2026) — снят
  // замером с присланного скриншота Apple Reminders, там у каждой плашки
  // такой же полый кружок слева от текста.
  circle: Circle,
};

export const Icon = ({
  name,
  size = 22,
  className = "",
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) => {
  // Единственное исключение из Lucide: многоцветный логотип Google.
  if (name === "google") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={className}
        style={style}
      >
        <path
          d="M22.5 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z"
          fill="#4285F4"
        />
        <path
          d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.9A11 11 0 0 0 12 23z"
          fill="#34A853"
        />
        <path
          d="M5.9 14.1a6.5 6.5 0 0 1 0-4.2V7H2.2a11 11 0 0 0 0 10l3.7-2.9z"
          fill="#FBBC05"
        />
        <path
          d="M12 5.3c1.5 0 2.9.5 3.9 1.5l2.9-2.9C17.5 2.3 15 1.3 12 1.3A11 11 0 0 0 2.2 7l3.7 2.9C6.8 7.1 9.2 5.3 12 5.3z"
          fill="#EA4335"
        />
      </svg>
    );
  }

  const Glyph = LUCIDE_ICONS[name];
  if (!Glyph) return null;

  // fill:"currentColor" раньше включался для ключа "homeFilled" — тот же
  // контур Home, залитый насквозь. Убрано целиком (2026-08-11): активная
  // вкладка «Обзор» заливалась сплошным пятном вместо того, чтобы просто
  // сменить цвет обводки, как остальные три вкладки. Заливки нет ни у
  // одной Lucide-иконки в проекте — всегда обводка (fill:"none").
  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      className={className}
      style={style}
      fill="none"
    />
  );
};

// ═══════════ STATUS BAR ═══════════
// Владелец 2026-08-12: фейковые часы «08:17» и батарея «49%» — убрать, даже
// несмотря на то что это часть телефонной рамки в mockup-reference (прямое
// решение, не рефакторинг под сомнением). Значок вызова (bellSlash),
// сигнал и wifi остаются — про них решения не было. Оставшиеся значки
// переведены на currentColor (раньше — литеральный "white"/rgba(255,255,
// 255,…)): на тёмной теме визуально не отличить, но на светлой (см.
// index.css, LIGHT THEME OVERRIDE) буквальный белый был бы невидим на
// светлом фоне рамки — currentColor наследует var(--color-text), которая
// меняется вместе с темой, как и всё остальное в этом компоненте.
export function StatusBar() {
  return (
    <div className="flex items-center justify-end px-[22px] h-[46px] shrink-0">
      <div className="flex items-center gap-[5px]">
        <Icon name="bellSlash" size={15} className="opacity-90" />
        <svg viewBox="0 0 16 13" className="w-[16px] h-[13px]">
          <rect
            x="0"
            y="6"
            width="2.5"
            height="5"
            rx="0.8"
            fill="currentColor"
          />
          <rect
            x="4.5"
            y="4"
            width="2.5"
            height="7"
            rx="0.8"
            fill="currentColor"
          />
          <rect
            x="9"
            y="2"
            width="2.5"
            height="9"
            rx="0.8"
            fill="currentColor"
          />
          <rect
            x="13.5"
            y="0"
            width="2.5"
            height="11"
            rx="0.8"
            fill="currentColor"
          />
        </svg>
        <svg viewBox="0 0 16 13" className="w-[16px] h-[13px]">
          <path
            d="M1 5a8 8 0 0 1 14 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M3.5 8a5 5 0 0 1 9 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="8" cy="11.5" r="1.6" fill="currentColor" />
        </svg>
      </div>
    </div>
  );
}

// ═══════════ AVATAR ═══════════

export function Avatar({
  initials,
  color,
  avatar_url,
  size = 32,
}: {
  initials?: string;
  color?: string;
  avatar_url?: string | null;
  size?: number;
}) {
  if (avatar_url) {
    // avatar_url из API — относительный путь (/api/avatars/...). В браузере
    // это резолвится к тому же origin, что и сам API (same-origin или через
    // vite-прокси) — работало бы как есть. Но в native-обёртке (Capacitor)
    // origin страницы — capacitor://localhost, а API живёт на отдельном
    // хосте (см. api/client.ts, API_BASE_URL) — относительный <img src>
    // ушёл бы туда же, в capacitor://localhost, и не загрузился бы. Тот же
    // урок, что уже был с самими API-запросами.
    const resolvedUrl = /^https?:\/\//.test(avatar_url)
      ? avatar_url
      : `${API_BASE_URL}${avatar_url}`;
    // НЕ rounded-full (Максим 18.08.2026): картинка-аватарка (в отличие от
    // буквенной ниже) не обязана заполнять весь квадрат своим силуэтом —
    // у большинства загруженных изображений останется свой фон по краям,
    // и круглая обрезка превращала его в заметный «кругляш» вокруг
    // рисунка. Небольшое скругление вместо строгого прямоугольника — та же
    // мера, что у карточек/кнопок в проекте, не полный круг.
    //
    // contain, НЕ cover: первая попытка (cover) заполняла квадрат целиком,
    // но обрезала персонажа по бокам/сверху, если пропорции картинки не
    // квадратные — «уже не картинка», лишние куски пропадали. contain
    // вписывает целиком, ценой пустых полей по короткой стороне у
    // неквадратных изображений — на прозрачном фоне это не пятно, просто
    // воздух.
    return (
      <img
        src={resolvedUrl}
        alt=""
        className="rounded-lg shrink-0"
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }
  const fallback = initials ?? "";
  const bg = color ?? "#A6A6A6";
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: size * 0.43,
        fontWeight: 600,
        color: "white",
      }}
    >
      {fallback}
    </div>
  );
}

// ═══════════ SHEET HANDLE ═══════════
// Полоска-индикатор в верхней части bottom sheet: намекает «можно потянуть
// вниз» (§8 Apple Design — hint in direction) и является точкой захвата для
// drag-to-dismiss. Принимает dragProps из useBottomSheet.

export function SheetHandle({
  dragProps,
}: {
  dragProps?: BottomSheetDragProps;
}) {
  return (
    <div className="flex justify-center pt-2 pb-1 -mx-4 px-4" {...dragProps}>
      <div className="w-9 h-1 rounded-full bg-stroke" />
    </div>
  );
}

// ═══════════ AGENT STATE TAG (task-row pometka, AGENT-PROTOCOL.md) ═══════════
// Compact inline pill for a task row's agent_state: "в работе · N мин
// назад" / "агент пропал" / "на проверке" / "заблокировано" — see
// AGENT-PROTOCOL.md, "Как это видит владелец". Same color convention as
// TaskJournal.tsx's AgentStatusRow (teal/orange/blue, coral for the stale
// "агент пропал" case) so the list and the task-detail screen never
// disagree about what a color means. Height stays within the row's
// existing `mt-1.5` badge slot (see TodayScreen.tsx's overdue pill) — no
// new row geometry.
const AGENT_TAG_META: Record<
  "in_progress" | "blocked" | "review",
  { label: string; bg: string; text: string }
> = {
  in_progress: { label: "в работе", bg: "bg-teal/15", text: "text-teal" },
  blocked: { label: "заблокировано", bg: "bg-orange/15", text: "text-orange" },
  review: { label: "на проверке", bg: "bg-blue/15", text: "text-blue" },
};

// `compact` — доска (TaskBoard.tsx: BoardCard, 260px колонка) уже тесна
// сама по себе, без этого варианта тег с "· N мин назад" вылезал бы за
// карточку рядом с другими футер-пилюлями (дата/подзадачи/метка). Тот же
// цвет и тот же смысл, что и в списке (TodayScreen) — меняется только
// геометрия: чуть меньше паддинг и относительное время скрыто целиком
// (не обрезано — обрезанное "· 5 …" читалось бы как баг, а не как дизайн).
export function AgentStateTag({
  task,
  compact = false,
}: {
  task: ApiTask;
  compact?: boolean;
}) {
  if (!task.agent_state) return null;

  const pad = compact ? "px-1.5 py-0.5" : "px-2 py-0.5";

  // "Агент пропал" — аренда истекла, задача всё ещё числится in_progress.
  // Отдельная, тревожная подача (плотнее заливка, жирный текст) — это
  // состояние требует решения владельца, в отличие от спокойного "в
  // работе". agent_stale вычисляется сервером (agentState.ts isStale) —
  // никогда не пересчитывается на клиенте.
  if (task.agent_state === "in_progress" && task.agent_stale) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${pad} rounded text-[11px] font-semibold bg-coral/20 text-coral`}
      >
        <Icon name="bot" size={10} />
        Агент пропал
        {!compact && task.agent_heartbeat_at && (
          <span className="font-normal opacity-80">
            · {formatRelativeTime(task.agent_heartbeat_at)}
          </span>
        )}
      </span>
    );
  }

  const meta = AGENT_TAG_META[task.agent_state];
  return (
    <span
      className={`inline-flex items-center gap-1 ${pad} rounded text-[11px] ${meta.bg} ${meta.text}`}
    >
      <Icon name="bot" size={10} />
      {meta.label}
      {!compact &&
        task.agent_state === "in_progress" &&
        task.agent_heartbeat_at && (
          <span className="opacity-80">
            · {formatRelativeTime(task.agent_heartbeat_at)}
          </span>
        )}
    </span>
  );
}

// ═══════════ BOTTOM NAV ═══════════

// Активная вкладка не получает никакой плашки-подложки — просто загорается
// красным иконка и подпись. Плашки вокруг иконок были собственной выдумкой
// (и вдобавок разной у разных вкладок), из-за чего подсветка выглядела кривой.
// Один icon на вкладку (без отдельного activeIcon): активное состояние —
// это только цвет (.nt-tabbar-menu__item.active в index.css), сам силуэт
// не меняется. Раньше у «Обзора» был отдельный activeIcon:"homeFilled" —
// тот же контур Home, но с fill:currentColor — и заливался сплошным
// красным пятном при активации (баг, 2026-08-11: «когда нажимаю, он весь
// заливается, ведёт себя неправильно»). Ключ homeFilled и fill-хак в Icon
// убраны целиком, а не просто выключены — иначе остались бы мёртвым кодом.
// Список вынесен в lib/navItems.ts — 2026-08-17, чтобы FanMenu.tsx мог
// переиспользовать его без oxlint(only-export-components) на этом файле.

// ── «Горбик»: дословный перенос ~/Проекты/CRM/CRM-Castom/frontend/src/
// components/ui/AnimatedTabBar.tsx + блока .menu* из index.css того проекта
// (задача 2026-08-11, владелец: «там есть рабочая, уже прям идеально
// выверенная вещь»). Логика позиционирования — AnimatedTabBar.tsx
// (getBoundingClientRect + ResizeObserver, 0 своих formul), геометрия горба
// — CSS-блок «AnimatedTabBar (перенос из CRM...)» в index.css (размеры в
// em, форма волны clip-path, единая тень). Полный список отличий от
// оригинала — в отчёте агента о переносе; коротко: цвет круга активной
// вкладки — наш красный акцент (это прямое требование задания, не выбор
// агента), подписей под иконками нет — оригинал их не рисует вообще, а
// дописать их означало бы поменять его числа (padding/высоту/подъём),
// что запрещено. Счётчик задач на «Сегодня» — наше дополнение (см.
// .nt-tabbar-badge в index.css), в оригинале его не было.
//
// Owner 2026-08-13 (десятый заход): счётчик раньше был виден постоянно,
// пока на «Сегодня» есть активные задачи — владелец: «я же уже увидел
// её, увидел, мне не надо, чтобы она постоянно маячила». Теперь счётчик
// гаснет ПОСЛЕ первого захода на /today в текущий день и не появляется
// заново до полуночи (или до перезахода следующим днём), даже если
// список задач меняется — правило простое («увидел раз — достаточно»),
// без отдельного отслеживания «появились ли НОВЫЕ задачи с прошлого
// захода». Хранится в localStorage (не sessionStorage) — иначе счётчик
// возвращался бы при каждом перезапуске вкладки/приложения в тот же день.
const TODAY_BADGE_SEEN_KEY = "taskflow_today_badge_seen_date";

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: allTasks = [] } = useTasks();
  const todayTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => t.due_date === todayStr() && t.status === "active",
      ),
    [allTasks],
  );
  const [badgeSeenDate, setBadgeSeenDate] = useState(() =>
    localStorage.getItem(TODAY_BADGE_SEEN_KEY),
  );
  useEffect(() => {
    if (location.pathname !== "/today") return;
    const today = todayStr();
    if (badgeSeenDate === today) return; // уже отмечено — не дёргать localStorage/render зря
    localStorage.setItem(TODAY_BADGE_SEEN_KEY, today);
    setBadgeSeenDate(today);
  }, [location.pathname, badgeSeenDate]);
  // Индикатора «ждут вас» в меню намеренно НЕТ. Пробовали и число, и
  // точку — решение владельца (11.08.2026): в меню показывается только
  // «сколько задач на сегодня», а то, что ждёт его решения, он видит
  // блоком «Ждут вас» на самом экране «Сегодня», когда туда заходит.
  const activeIndex = Math.max(
    0,
    NAV_ITEMS.findIndex((item) => item.path === location.pathname),
  );

  const tabItems: TabItem[] = NAV_ITEMS.map((item) => {
    const isToday = item.path === "/today";
    const showBadge =
      isToday && todayTasks.length > 0 && badgeSeenDate !== todayStr();
    return {
      // Счётчик — не только визуально (.nt-tabbar-badge), но и в
      // aria-label: у AnimatedTabBar.tsx badge помечен aria-hidden (это
      // просто цифра поверх иконки, дублировать её скринридеру дважды не
      // нужно), поэтому число обязано попасть в единственное место, которое
      // скринридер озвучивает — сам label кнопки.
      label: showBadge
        ? `${item.label}, задач: ${todayTasks.length}`
        : item.label,
      icon: (
        <span className="relative inline-flex">
          <Icon name={item.icon} size={22} />
          {showBadge && (
            <span className="nt-tabbar-badge" aria-hidden="true">
              {todayTasks.length}
            </span>
          )}
        </span>
      ),
    };
  });

  return (
    <nav
      // z-35, было z-20: FAB (z-30, ../UI.tsx FAB) стоит над панелью и тащит
      // за собой свой красный shadow (blur 16px) — тот выступает ниже самой
      // кнопки. Вставать выше диалогов (z-40/z-50, см. Dialog.tsx,
      // RescheduleSheet.tsx, TaskJournal.tsx, ActivityScreen.tsx,
      // ActionsMenu.tsx) z-35 не даёт — они по-прежнему перекрывают панель.
      className="fixed inset-x-0 bottom-0 z-[35] px-4"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
    >
      <AnimatedTabBar
        items={tabItems}
        defaultIndex={activeIndex}
        onTabChange={(i) => navigate(NAV_ITEMS[i].path)}
      />
    </nav>
  );
}

// ═══════════ SIDE NAV (desktop) ═══════════
// Same four destinations as BottomNav (NAV_ITEMS above) rendered as a
// vertical list instead of a horizontal bar — Layout.tsx swaps one for the
// other by breakpoint, never both at once. Deliberately its own small
// component rather than a shared refactor of BottomNav/AnimatedTabBar: that
// bar's whole geometry (gooey "horka" clip-path, em-scale tied to a
// specific font-size, corner-overlay badge) is built for a horizontal strip
// and doesn't have a vertical equivalent worth inventing for four rows —
// see the "AnimatedTabBar (перенос из CRM...)" block in index.css.
//
// Active-state color is not invented here either: it's the exact rule
// already decided for these four destinations a few paragraphs up
// ("активная вкладка не получает никакой плашки-подложки — просто
// загорается красным иконка и подпись") — same red/dim tokens, no
// background pill, just reused for a column instead of a row. The row
// treatment itself (`.tap-row`) is index.css's own documented case for
// "sidebar/menu-drawer items" — see that class's comment block. The hover
// step (dim → sub) mirrors Panel's own hover a few hundred lines down
// (text-sub → text-text) one rung lower on the same dim/sub/text brightness
// ladder in @theme — not a new value, only active rows skip it (they're
// already red, hovering them shouldn't dull the color).
export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: allTasks = [] } = useTasks();
  const todayCount = useMemo(
    () =>
      allTasks.filter((t) => t.due_date === todayStr() && t.status === "active")
        .length,
    [allTasks],
  );

  return (
    <nav className="w-60 h-full shrink-0 flex flex-col gap-1 p-4 border-r border-stroke">
      {NAV_ITEMS.map((item) => {
        const active = item.path === location.pathname;
        const showBadge = item.path === "/today" && todayCount > 0;
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => navigate(item.path)}
            aria-current={active ? "page" : undefined}
            className={`tap-row w-full h-12 flex items-center gap-3 px-3 rounded-xl text-[14px] ${
              active ? "text-red" : "text-dim hover:text-sub"
            }`}
          >
            <Icon name={item.icon} size={22} />
            <span className="flex-1 text-left truncate">{item.label}</span>
            {showBadge && (
              <span className="min-w-5 h-5 px-1 rounded-full bg-red text-white text-[11px] font-bold flex items-center justify-center leading-none shrink-0">
                {todayCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ═══════════ FAB ═══════════

export function FAB({
  onClick,
  // Создание из раздела «Сегодня» сразу проставляет сегодняшний срок
  // (владелец 19.08.2026: «логично, если я и сегодня создаю»). В
  // остальных разделах задача по-прежнему заводится БЕЗ срока — это
  // отдельное решение владельца от 10.08.2026 (как в Todoist: задача без
  // даты падает во «Входящие»), и трогать его здесь нельзя.
  dueToday,
}: {
  onClick?: () => void;
  dueToday?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <button
      onClick={
        onClick ?? (() => navigate(`/task/new${dueToday ? "?due=today" : ""}`))
      }
      className="fab-safe-bottom fixed right-[18px] w-[58px] h-[58px] rounded-full bg-red flex items-center justify-center shadow-[0_6px_16px_rgba(228,67,50,.45)] z-30 tap-scale"
    >
      <Icon name="plus" size={26} className="text-white" />
    </button>
  );
}

// ═══════════ BACK BUTTON ═══════════

export function BackButton({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-11 h-11 -ml-2.5 flex items-center justify-center ${className}`}
      aria-label="Назад"
    >
      <Icon name="chevronLeft" size={22} />
    </button>
  );
}

// ═══════════ SCREEN HEADER ═══════════
// Sticky header for screen roots. Two variants matching the two header
// shapes already used across the app:
//   - "large" (default): big left-aligned title, e.g. Inbox/Today/
//     Overview. `actions` (view-toggle buttons, icons, …) render as a row
//     to the right of the title, same line.
//   - "compact": iOS-nav-bar shape used by detail/secondary screens
//     (Register, TaskDetail, NewTask, Settings, …) — an optional
//     `leading` element (usually a back button) on the left, a title
//     genuinely centered via absolute positioning, and `actions` pinned
//     to the right.
//
// Usage:
//   <ScreenHeader title="Входящие" actions={<>{viewToggleButtons}</>} />
//
//   <ScreenHeader
//     variant="compact"
//     leading={<BackButton onClick={() => navigate(-1)} />}
//     title="Регистрация"
//   />
//
// Renders `sticky top-0`, so drop it as the first child inside a screen's
// existing `px-4 ...` root div — no extra wrapper/margin needed, it just
// stays put at the top of the (document-level) scroll while the rest of
// the screen's content scrolls underneath it.
//
// Screens wrap their content in a horizontally-padded root (`px-4` on most
// screens, `px-5` on RegisterScreen, and on UpcomingScreen there's a whole
// extra unpadded sticky wrapper between this component and the padded
// root — see UpcomingScreen.tsx). Left to the DOM, that padding clips this
// header's sticky background/border along with everything else, so a
// couple of the padded pixels of whatever's scrolling underneath show
// through on both sides once the header is stuck at the top (owner report
// 2026-08-11, Inbox screen, 16px slivers left/right). None of that padding
// is a fixed, known number this component could just subtract — it varies
// per screen and this component can't reach into every screen to
// normalize it — so `useFullBleedInset` below measures it live off the DOM
// instead: it walks up from this header's *parent* (so nesting like
// Upcoming's extra wrapper is transparent to it) to the nearest real
// scroll container — Layout.tsx's `.overflow-y-auto` frame, on both mobile
// and desktop, or `document` itself for screens like /register that render
// outside Layout and scroll the page — and reads how far the parent's
// content box sits from that container's edges. Negative margin cancels
// exactly that gap so this element's background/border box spans the full
// container width; equal-and-opposite padding re-indents the actual
// title/actions row by the same amount, so they land back on the exact
// pixels the screen's own padding would have put them on. Measuring the
// *parent* (never touched by the inline style this hook produces) rather
// than this element's own box is deliberate — re-measuring your own
// already-bled box on a later resize would read back the compensated
// position instead of the original gap and unravel the fix.
function findScrollContainer(node: HTMLElement): HTMLElement {
  let el: HTMLElement | null = node;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return el;
    el = el.parentElement;
  }
  return document.documentElement;
}

function useFullBleedInset(ref: RefObject<HTMLElement | null>) {
  const [inset, setInset] = useState<{
    left: number;
    right: number;
    width?: number;
  }>({ left: 0, right: 0 });

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;

    const measure = () => {
      const container = findScrollContainer(parent);
      const parentRect = parent.getBoundingClientRect();
      const parentStyle = getComputedStyle(parent);
      const contentLeft =
        parentRect.left +
        parseFloat(parentStyle.borderLeftWidth || "0") +
        parseFloat(parentStyle.paddingLeft || "0");
      const contentRight =
        parentRect.right -
        parseFloat(parentStyle.borderRightWidth || "0") -
        parseFloat(parentStyle.paddingRight || "0");
      const containerRect = container.getBoundingClientRect();
      const left = Math.max(0, Math.round(contentLeft - containerRect.left));
      const right = Math.max(0, Math.round(containerRect.right - contentRight));
      // Width is pinned explicitly (not left to `auto` + the negative
      // margins to sort out on their own) because some callers render this
      // header inside a *centering* flex parent with their own `w-full`
      // override on top of ours (TodayScreen.tsx's empty state: `flex
      // flex-col items-center` wrapping a `className="w-full"` header). In
      // that shape two things independently break a margin-only bleed:
      // `w-full` resolves to 100% of the *content* box (the padded-in
      // width, e.g. 358), not the auto-expanded full-bleed width the plain
      // block case gets for free, so the box is simply too narrow; and
      // even set to the right width, `align-items: center` centers an
      // item's margin box using its negative margins at face value, which
      // re-shifts an already-correct 390-wide box back inward by exactly
      // the bled amount. Pinning `width` inline (highest specificity, wins
      // over any `w-full` class) to the container's own full span sidesteps
      // both: the box is the right size AND its margin-box, at that size,
      // has zero leftover free space for align-items to redistribute.
      const width = Math.round(containerRect.right - containerRect.left);
      setInset((prev) =>
        prev.left === left && prev.right === right && prev.width === width
          ? prev
          : { left, right, width },
      );
    };

    measure();
    const container = findScrollContainer(parent);
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);

  return inset;
}

// Публикует реальную высоту шапки в CSS-переменную --screen-header-h на
// ближайшем скроллящемся предке (19.08.2026, для DayHours: строка с
// подписями дней в 3-дневном виде тоже sticky top:0, и без этого числа
// садилась НА ТО ЖЕ место, что и эта шапка (z-20), пряталась под ней
// целиком — два sticky top:0 подряд не складывают отступы сами по себе,
// второй должен явно знать высоту первого). Та же техника измерения, что
// у useFullBleedInset выше (ResizeObserver + findScrollContainer) — не
// хардкодить число, шапка бывает large/compact разной высоты.
function usePublishHeaderHeight(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const container = findScrollContainer(el);
    const measure = () => {
      container.style.setProperty("--screen-header-h", `${el.offsetHeight}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      // Экран без шапки (ScreenHeader размонтирован) не должен оставлять
      // чужой sticky-элемент приклеенным к высоте, которой больше нет.
      container.style.removeProperty("--screen-header-h");
    };
  }, [ref]);
}

// Маски и подложка «стеклянной» шапки. Считаются снизу вверх: у нижнего
// края шапки контент виден как есть, к верхней кромке экрана полностью
// уходит в муть. Числа подобраны на глаз по живому экрану — точка, где
// начинается размытие (55% высоты у сильного слоя), и есть та самая
// «середина под шапкой», о которой просил владелец.
const HEADER_FADE_STRONG =
  "linear-gradient(to bottom, #000 0%, #000 50%, rgba(0,0,0,0.4) 72%, transparent 88%)";
const HEADER_FADE_SOFT =
  "linear-gradient(to bottom, #000 0%, #000 62%, rgba(0,0,0,0.55) 84%, transparent 100%)";
// Цвет фона: плотный у верхней кромки (под ним не должно просвечивать
// вообще ничего), к низу сходит на нет. color-mix — чтобы работало в обеих
// темах от одного токена, а не двумя захардкоженными цветами.
const HEADER_TINT =
  "linear-gradient(to bottom, var(--color-bg) 0%, var(--color-bg) 42%, color-mix(in srgb, var(--color-bg) 80%, transparent) 62%, color-mix(in srgb, var(--color-bg) 35%, transparent) 82%, transparent 100%)";

export function ScreenHeader({
  title,
  leading,
  actions,
  variant = "large",
  className = "",
}: {
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  variant?: "large" | "compact";
  className?: string;
}) {
  const isCompact = variant === "compact";
  const rootRef = useRef<HTMLDivElement>(null);
  const bleed = useFullBleedInset(rootRef);
  usePublishHeaderHeight(rootRef);
  return (
    <div
      ref={rootRef}
      // mb-4 (16px) — Максим 17.08.2026: «пройтись по всем окнам и
      // подбить, чтобы все начиналось ровно с одинаковыми отступами».
      // Раньше каждый экран решал сам (или не решал вовсе): у Overview
      // было mb-5, у Settings — не было совсем (профиль лип к заголовку),
      // у TaskDetail — тоже 0 (название задачи лезло вплотную под шапку),
      // у Today/Upcoming — тоже не было. Отступ теперь часть самой шапки,
      // не копия одного числа в 15 экранах — обновить его снова значит
      // поменять одну строку здесь, а не искать все места. Ставится
      // ПОСЛЕДНИМ классом в строке, до внешнего className — единственный
      // экран, где className что-то своё несёт (TodayScreen, w-full для
      // пустого состояния), к margin отношения не имеет и не конфликтует.
      className={`sticky top-0 z-20 mb-4 ${className}`}
      style={{
        marginLeft: -bleed.left,
        marginRight: -bleed.right,
        paddingLeft: bleed.left,
        paddingRight: bleed.right,
        ...(bleed.width !== undefined ? { width: bleed.width } : {}),
      }}
    >
      {/* ═══ Затухание вместо сплошной плашки (Максим 19.08.2026) ═══
          «Верхушку сделать прозрачную, с последующим затуханием: вначале
          нормальная видимость, под шапкой посередине уже мутно, а ближе к
          верху экрана прям исчезает».

          Было `bg-bg/90 backdrop-blur-xl border-b` — то есть почти
          непрозрачная плашка с резкой границей: контент под ней просто
          пропадал, а линия внизу подчёркивала обрыв.

          Стало два слоя размытия со сдвинутыми масками (у одного
          backdrop-filter силы не хватает: он даёт ОДНУ степень размытия на
          всю высоту, а маска только гасит её целиком — плавного перехода
          «чётко → мутно → ничего» из него не выжать) плюс градиент цвета
          фона поверх, чтобы заголовок и кнопки читались над любым
          контентом. Границы больше нет — она спорила бы с плавностью.

          -webkit-backdrop-filter и -webkit-mask-image обязательны: Максим
          смотрит с айфона, в WebKit без префикса не работает ни то, ни
          другое (рецепт из памяти, frosted-glass-sticky-header). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 bottom-0"
        style={{
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          maskImage: HEADER_FADE_STRONG,
          WebkitMaskImage: HEADER_FADE_STRONG,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 bottom-0"
        style={{
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          maskImage: HEADER_FADE_SOFT,
          WebkitMaskImage: HEADER_FADE_SOFT,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 bottom-0"
        style={{ background: HEADER_TINT }}
      />
      <div
        className={`flex items-center gap-2 relative z-10 ${
          isCompact ? "h-[48px]" : "min-h-[56px] py-2"
        }`}
      >
        {leading}
        {isCompact ? (
          <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold whitespace-nowrap">
            {title}
          </h2>
        ) : (
          <h1 className="flex-1 min-w-0 truncate text-[28px] font-bold">
            {title}
          </h1>
        )}
        {actions && (
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════ PANEL (reference sidebar) ═══════════

const PANEL_ITEMS = [
  { label: "Обзор", path: "/overview" },
  { label: "Настройки", path: "/settings" },
  { label: "Предстоящее", path: "/upcoming" },
  { label: "Сегодня (пусто)", path: "/today" },
  { label: "Входящие", path: "/inbox" },
  { label: "Логин", path: "/login" },
  { label: "Регистрация", path: "/register" },
  { label: "Новая задача", path: "/task/new" },
  { label: "Уведомления", path: "/notifications" },
  { label: "Агенты", path: "/agents" },
  { label: "Проекты", path: "/projects" },
  { label: "Поиск", path: "/search" },
];

export function Panel() {
  const navigate = useNavigate();
  return (
    <aside className="hidden xl:flex flex-col w-[260px] p-4 border-l border-stroke gap-2">
      <h4 className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-1">
        Экраны · Референсы
      </h4>
      {PANEL_ITEMS.map((item, i) => (
        <button
          key={item.path}
          onClick={() => navigate(item.path)}
          className="w-full flex items-center gap-2 px-2 py-[5px] rounded-lg tap-row text-left text-[13px] text-sub hover:text-text"
        >
          <span className="w-4 text-[11px] text-dim text-right shrink-0">
            {i + 1}
          </span>
          {item.label}
        </button>
      ))}
      <div className="mt-auto text-center text-[11px] text-dim leading-relaxed">
        React + Tailwind · Todoist dark
        <br />
        собран 1:1 по скриншотам от 10.08.2026
      </div>
    </aside>
  );
}

// ═══════════ FORM PRIMITIVES ═══════════
// Unified spacing/radius scale for forms across the app:
//   - FieldGroup: bg-card rounded-2xl card wrapping a list of rows, with a
//     single consistent inset divider (h-px bg-stroke mx-4) between them.
//   - TextField: one icon+input row, fixed 52px height (comfortable >44px
//     touch target), meant to live inside a FieldGroup.
//   - Button: full-width h-12 (48px) CTA with a small variant set.

export function FieldGroup({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      {items.map((child, i) => (
        <div key={i}>
          {child}
          {i < items.length - 1 && <div className="h-px bg-stroke mx-4" />}
        </div>
      ))}
    </div>
  );
}

export function TextField({
  icon,
  trailing,
  className = "",
  systemKeyboard,
  ...inputProps
}: {
  icon?: string;
  trailing?: ReactNode;
  className?: string;
  /** true — обычная системная клавиатура, как было до своей (ТЗ §3 шаг 3). */
  systemKeyboard?: boolean;
} & ComponentPropsWithoutRef<"input">) {
  return (
    <div className="flex items-center gap-3 px-4 h-[52px]">
      {icon && <Icon name={icon} size={18} className="text-dim shrink-0" />}
      <input
        {...inputProps}
        // Своя клавиатура подключается делегированием на уровне
        // KeyboardProvider (lib/keyboardContext.tsx) — по DOM, не по пропсам,
        // потому что 14 полей в проекте написаны мимо этого компонента.
        // Здесь остаётся только опт-аут: атрибут, который перехват уважает.
        data-system-keyboard={systemKeyboard ? "" : undefined}
        className={`flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none ${className}`}
      />
      {trailing}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "outline";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-red text-white",
  secondary: "bg-card2 border border-stroke text-text",
  outline: "border border-stroke text-sub bg-transparent",
};

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: {
  variant?: ButtonVariant;
  className?: string;
} & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      {...props}
      className={`w-full h-12 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-3 tap-fade disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// ═══════════ ERROR BANNER ═══════════
// Generalizes InboxScreen's inline query-error line (`<p className="px-1
// text-[13px] text-coral">…</p>`) into a reusable primitive that also
// covers mutation errors. Accepts the raw `error` — a caught exception, a
// mutation's `.error`, or a plain string already extracted into local
// state (e.g. the try/catch pattern in LoginScreen/RegisterScreen) — and
// runs it through getErrorMessage itself, so callers never need to call
// that separately. Renders nothing for a falsy/empty error, so it's safe
// to mount unconditionally: `<ErrorBanner error={mutation.error} />` with
// no surrounding `{mutation.isError && ...}` needed.
//
//   - variant="inline" (default): exact InboxScreen look — a plain coral
//     line. Use for query-load errors and anywhere space is tight.
//   - variant="block": a tinted rounded panel (same bg-X/opacity tint
//     pattern as the app's label pills / UpcomingScreen's "Просрочено"
//     chip), with an icon. Use directly above a form's submit/save button
//     for mutation errors — the "офлайн жмёт «Сохранить»" case needs more
//     visual weight than a thin text line under a long scrolling list.
//
// Always pass `fallback` — a specific, Russian, one-sentence description
// of what failed ("Не удалось сохранить задачу"). The server's own error
// strings are a mix of Russian and English (see getErrorMessage in
// ../lib/errors); English ones are swapped for `fallback` automatically,
// so a call site that omits it can end up showing only a generic
// "Что-то пошло не так" for what might be a very common, specific failure.
export function ErrorBanner({
  error,
  fallback,
  variant = "inline",
  className = "",
}: {
  error: unknown;
  fallback?: string;
  variant?: "inline" | "block";
  className?: string;
}) {
  const message = getErrorMessage(error, fallback);
  if (!message) return null;

  if (variant === "block") {
    return (
      <div
        role="alert"
        className={`flex items-start gap-2 bg-coral/12 text-coral rounded-xl px-3 py-2.5 text-[13px] leading-relaxed ${className}`}
      >
        <Icon name="info" size={15} className="shrink-0 mt-[1px]" />
        <span>{message}</span>
      </div>
    );
  }

  return (
    <p role="alert" className={`px-1 text-[13px] text-coral ${className}`}>
      {message}
    </p>
  );
}
