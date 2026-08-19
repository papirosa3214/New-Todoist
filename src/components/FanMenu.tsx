// ═══════════ FAN MENU (веер) ═══════════
// Задача Максима 17.08.2026: одна кнопка внизу по центру вместо
// BottomNav (горбик) + FAB — тап раскрывает веер вверх, полукругом, в
// нижней части экрана. Форма и физика взяты из присланного им референса
// (круговое command-меню на framer-motion) и адаптированы под то, что уже
// есть в проекте: framer-motion в зависимостях нет и не заводится — та же
// связка opacity+scale+сдвиг одной пружиной, что уже использует
// ActionsMenu.tsx, просто своя пружина на каждый пункт (useMultiSpring —
// см. файл, зачем не пять useSpring() в цикле).
//
// Геометрия — НЕ на глаз: числа подобраны Максимом вживую в HTML-прототипе
// (панель с ползунками радиус/шаг/размер + счётчик зазора) и зафиксированы
// как есть, один в один:
//   радиус дуги 100px, шаг между пунктами 45°, кружок пункта 56px,
//   кнопка-триггер 64px — при пяти пунктах (см. showAdd) крайние ложатся
//   ровно на высоту триггера (угол -180°/0°), только средние три
//   поднимаются дугой. Менять эти четыре числа — значит менять то, что уже
//   утверждено, не «поправить мелочь».
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "./UI";
import { NAV_ITEMS } from "../lib/navItems";
import { useSpring } from "../lib/useSpring";
import { useMultiSpring } from "../lib/useMultiSpring";

const TRIGGER_SIZE = 64;
const ITEM_SIZE = 56;
const RADIUS = 100;
const STEP_DEG = 45;
// Кнопка и кружки веера всегда центрированы на одной точке — центре
// триггера. bottom:SAFE_BOTTOM у триггера даёт его НИЖНИЙ край; центр —
// на TRIGGER_SIZE/2 выше. Кружку веера, чтобы его СОБСТВЕННЫЙ центр попал
// в ту же точку, нужен свой bottom меньше на ITEM_SIZE/2. Разница между
// этими двумя отступами — TRIGGER_SIZE/2 - ITEM_SIZE/2 = 32-28 = 4px,
// величина не зависящая от safe-area (обе кнопки съезжают с вырезом
// экрана вместе). См. таблицу «Просвет триггер → веер» в прототипе.
const SAFE_BOTTOM = "max(16px, env(safe-area-inset-bottom))";
const ITEM_BOTTOM_EXTRA = TRIGGER_SIZE / 2 - ITEM_SIZE / 2; // 4
const STAGGER_MS = 50; // задержка на пункт — как в присланном референсе (delay: index*0.05)

// Отступ под контент, когда внизу веер вместо BottomNav — замена
// .pb-content-safe (та посчитана под высоту «горбика», не под триггер).
// Занятая высота = TRIGGER_SIZE + минимальный отступ(SAFE_BOTTOM) + 8px
// запаса. Используется Layout.tsx.
export const FAN_MENU_CONTENT_PADDING = `calc(${SAFE_BOTTOM} + ${TRIGGER_SIZE + 8}px)`;

type FanItem = { path: string; label: string; icon: string };

// Пункта «Добавить» в веере НЕТ (владелец 19.08.2026, отдельно повторено:
// «в веер это вообще не нужна, эта кнопка»). Задача заводится удержанием
// центральной кнопки — она на экране всегда, поэтому дублировать её
// пунктом внутри того же меню незачем.

// Настройки — крайним пунктом веера (владелец 19.08.2026: «добавить
// задачу всегда по центру, а все остальные настройки в самом крайнее
// правое»). Раньше до них приходилось идти через «Обзор», что владелец
// назвал неудобным.
const SETTINGS_ITEM: FanItem = {
  path: "/settings",
  label: "Настройки",
  icon: "gear",
};

function buildItems(): FanItem[] {
  return [...NAV_ITEMS, SETTINGS_ITEM];
}

// Порог удержания. 400 мс — обычный системный «long press»: короче
// начинает срабатывать на обычных тапах, длиннее ощущается как зависание.
const HOLD_MS = 400;

// Проп showAdd больше не принимается: состав веера от него не зависит
// (пункта «Добавить» там нет), а удержание центральной кнопки заводит
// задачу ВЕЗДЕ, включая доску — владелец 19.08.2026: «чтобы в канбане на
// удержание она всё равно создавала задачу».
export function FanMenu() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);

  // Список пунктов «замораживается» на момент ОТКРЫТИЯ и не пересчитывается,
  // пока меню открыто или закрывается — даже если showAdd успеет поменяться
  // (маршрут сменился, hideFAB пересчитался). Баг 17.08.2026: раньше список
  // (и его длина n) шёл прямо от showAdd-пропа, поэтому смена count ПОСРЕДИ
  // closing-анимации — клик по пункту одновременно закрывает веер И
  // навигирует, а новый route может поменять showAdd — обнуляла состояние
  // пружин в useMultiSpring (пересоздание Float64Array при смене count) без
  // финального обновления DOM: кружок замирал на полпути закрытия — сам
  // rAF-цикл после сброса решает, что двигать нечего, и останавливается, а
  // opacity/transform в DOM остаются от последнего кадра — тап срабатывал
  // только со второго раза (новый цикл toggle).
  // Следующее открытие всегда берёт актуальный showAdd — устаревать нечему.
  const [menuItems, setMenuItems] = useState<FanItem[]>(() => buildItems());
  const n = menuItems.length;

  // Угол пункта i: дуга центрирована строго вверх (-90°), симметрично по
  // STEP_DEG вокруг середины списка — формула одна для чётного и нечётного
  // n (совпадает с «центральным индексом» при нечётном n).
  const offsets = useMemo(() => {
    const mid = (n - 1) / 2;
    return menuItems.map((_, i) => {
      const angleRad = ((-90 + (i - mid) * STEP_DEG) * Math.PI) / 180;
      return {
        tx: Math.cos(angleRad) * RADIUS,
        ty: Math.sin(angleRad) * RADIUS,
      };
    });
  }, [menuItems, n]);

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  // Icon — обычный компонент без forwardRef, ref в него не пробросить —
  // вращаем обёртку-span вокруг него, визуально то же самое.
  const iconWrapRef = useRef<HTMLSpanElement | null>(null);

  // Один пункт = одна пружина на общем rAF-цикле (useMultiSpring), value
  // 0..1 разом двигает opacity/scale/смещение — тот же приём, что
  // ActionsMenu.tsx гонит opacity+scale одной пружиной.
  const itemSprings = useMultiSpring(
    n,
    (index, value) => {
      const el = itemRefs.current[index];
      if (!el) return;
      const { tx, ty } = offsets[index];
      const scale = 0.5 + 0.5 * value;
      el.style.opacity = String(value);
      el.style.transform = `translate3d(${tx * value}px, ${ty * value}px, 0) scale(${scale})`;
      el.style.pointerEvents = value > 0.5 ? "auto" : "none";
    },
    { response: 0.34, damping: 1 },
  );

  // Общий scrim + поворот иконки триггера — своя пружина, response:0.2
  // как в ActionsMenu (то же назначение: быстрое появление маленького
  // меню).
  const openSpring = useSpring(
    (value) => {
      if (scrimRef.current) {
        scrimRef.current.style.opacity = String(value);
        scrimRef.current.style.pointerEvents = value > 0.05 ? "auto" : "none";
      }
      if (iconWrapRef.current) {
        iconWrapRef.current.style.transform = `rotate(${value * 45}deg)`;
      }
    },
    { response: 0.2, damping: 1 },
  );

  // Отложенные setTimeout-запуски стаггера — id храним, чтобы быстрый
  // повторный toggle() (открыл → тут же передумал/выбрал пункт) отменял
  // ещё не сработавшие таймауты прошлого вызова, а не давал им позже
  // дёрнуть пружину в обратную сторону поверх уже идущей новой анимации
  // (короткий, но заметный флик на пунктах 2–5 при быстром тапе).
  const pendingTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  function toggle(next: boolean) {
    pendingTimeouts.current.forEach(clearTimeout);
    pendingTimeouts.current = [];

    // Список фиксируется заново только при открытии — см. комментарий у
    // menuItems выше. При закрытии домённый снимок остаётся как был.
    const activeItems = next ? buildItems() : menuItems;
    if (next) setMenuItems(activeItems);

    setOpen(next);
    openSpring.animateTo(next ? 1 : 0);
    activeItems.forEach((_, i) => {
      const id = setTimeout(
        () => itemSprings.animateTo(i, next ? 1 : 0),
        i * STAGGER_MS,
      );
      pendingTimeouts.current.push(id);
    });
  }

  useLayoutEffect(() => {
    return () => {
      pendingTimeouts.current.forEach(clearTimeout);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggle(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      {/* Без затемнения (19.08.2026, владелец: «не надо, чтобы он
          темнел») — верхушка экрана (статус-бар/шапка) в затемнение не
          попадает и создаёт видимый шов с потемневшим низом. Div остаётся
          только как кликабельная подложка — тап вне веера закрывает его. */}
      <div
        ref={scrimRef}
        className="fixed inset-0 z-[34]"
        style={{ opacity: 0, pointerEvents: "none" }}
        onClick={() => toggle(false)}
        aria-hidden="true"
      />

      {menuItems.map((item, i) => {
        const active = item.path === location.pathname;
        return (
          <button
            key={item.path}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            aria-label={item.label}
            aria-hidden={!open}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              toggle(false);
              navigate(item.path);
            }}
            className="tap-scale fixed left-1/2 z-[35] flex items-center justify-center rounded-full border border-stroke bg-card2 shadow-[0_6px_16px_rgba(0,0,0,.22)]"
            style={{
              width: ITEM_SIZE,
              height: ITEM_SIZE,
              marginLeft: -ITEM_SIZE / 2,
              bottom: `calc(${SAFE_BOTTOM} + ${ITEM_BOTTOM_EXTRA}px)`,
              opacity: 0,
              transform: "translate3d(0,0,0) scale(0.5)",
              pointerEvents: "none",
            }}
          >
            <Icon
              name={item.icon}
              size={22}
              className={active ? "text-red" : "text-sub"}
            />
          </button>
        );
      })}

      <button
        type="button"
        // Короткий тап — веер, удержание — сразу новая задача (владелец
        // 19.08.2026). Обработка на pointer-событиях, а не onClick:
        // click приходит уже после отпускания, и отличить «подержал» от
        // «нажал» в нём нечем. onPointerLeave/Cancel обязательны — палец
        // может уехать с кнопки, и тогда не должно случиться ни того, ни
        // другого.
        onPointerDown={() => {
          heldRef.current = false;
          holdTimer.current = setTimeout(() => {
            heldRef.current = true;
            if (open) toggle(false);
            navigate("/task/new");
          }, HOLD_MS);
        }}
        onPointerUp={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (!heldRef.current) toggle(!open);
        }}
        onPointerLeave={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
        }}
        onPointerCancel={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
        }}
        aria-expanded={open}
        aria-label={
          open
            ? "Закрыть меню разделов"
            : "Открыть меню разделов, удержание — новая задача"
        }
        // Матовое тёмное стекло вместо плоской красной заливки — Максим
        // 17.08.2026: «оно выбивается из общего стиля», хотел тёмное и
        // прозрачное, а из-под стекла — аккуратное свечение. Свечение
        // (внешний shadow) Максим прямо попросил не трогать («забей на
        // подсветку, всё нормально») — второй заход тем же днём был
        // только про саму заливку: «более прозрачную кнопку, чтобы видно
        // было, как текст мимо неё проходит, когда скроллю». backdrop-blur
        // снижен дважды: -xl → -md было мало, текст под кнопкой
        // всё ещё было не разобрать — до -sm (совсем без blur контент
        // мелькал бы нечитаемым шумом при скролле, тут ищем баланс, не
        // убираем матовость целиком). alpha обеих стоп градиента снижена
        // вслед (.5→.32→.28, .55→.4→.3) — тонкая светлая обводка (border-white/10) отделяет край
        // стекла от фона за ним, как и положено стеклу.
        className="tap-scale fixed left-1/2 z-[36] flex items-center justify-center rounded-full border border-white/10 text-white shadow-[0_8px_32px_rgba(228,67,50,.4)] backdrop-blur-sm"
        style={{
          width: TRIGGER_SIZE,
          height: TRIGGER_SIZE,
          marginLeft: -TRIGGER_SIZE / 2,
          bottom: SAFE_BOTTOM,
          background:
            "radial-gradient(circle at 50% 35%, rgba(228,67,50,.28), rgba(23,23,23,.3) 72%)",
        }}
      >
        <span ref={iconWrapRef} className="inline-flex">
          <Icon name="plus" size={26} />
        </span>
      </button>
    </>
  );
}
