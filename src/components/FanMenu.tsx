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
import { hapticGrab } from "../lib/haptics";
import { useSpring } from "../lib/useSpring";
import { useMultiSpring } from "../lib/useMultiSpring";

const TRIGGER_SIZE = 64;
const ITEM_SIZE = 56;
const RADIUS = 100;
// Шаг между пунктами. Раньше был жёстко 45°, и это работало ровно до
// пяти пунктов: 4 промежутка × 45° = 180°, точный полукруг. Шестой пункт
// (Дневник, 26.08.2026) дал бы 225° — два крайних кружка уехали бы НИЖЕ
// центра триггера, то есть под нижний край экрана. Поэтому шаг считается
// от числа пунктов: дуга всегда ровно 180°, кружки просто становятся
// теснее. При 5 пунктах формула даёт те же 45°, что и раньше.
const FAN_ARC_DEG = 180;
const stepFor = (n: number) => (n > 1 ? FAN_ARC_DEG / (n - 1) : 0);
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

// Настроек в веере БОЛЬШЕ НЕТ (26.08.2026). Они стояли крайним пунктом с
// 19.08.2026, когда до них приходилось идти через «Обзор» и это было
// неудобно. Теперь в «Обзоре» они лежат обычной широкой строкой под
// «Активностью и статистикой» — Максим: «не маленькую шестеренку, чтобы
// тянуться до нее далеко было, а просто кнопку такую же самую». Место в
// веере освободилось, и он вернулся к пяти пунктам (шаг дуги снова 45°).
// Держать оба входа нельзя: одна функция — один вход.

function buildItems(): FanItem[] {
  return [...NAV_ITEMS];
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
      const angleRad = ((-90 + (i - mid) * stepFor(n)) * Math.PI) / 180;
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
  const shineRef = useRef<HTMLSpanElement | null>(null);

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
            className="tap-scale fixed left-1/2 z-[35] flex items-center justify-center rounded-full border border-white/20 bg-card2/85 shadow-fan-item backdrop-blur-md active:scale-95"
            style={{
              width: ITEM_SIZE,
              height: ITEM_SIZE,
              marginLeft: -ITEM_SIZE / 2,
              bottom: `calc(${SAFE_BOTTOM} + ${ITEM_BOTTOM_EXTRA}px)`,
              opacity: 0,
              transform: "translate3d(0,0,0) scale(0.5)",
              pointerEvents: "none",
              boxShadow: active
                ? "inset 0 1px 1px 0 rgba(255,255,255,0.40), 0 8px 24px -2px rgba(228,67,50,0.35), 0 0 0 1px rgba(228,67,50,0.5)"
                : "inset 0 1px 1px 0 rgba(255,255,255,0.30), inset 0 -1px 1px 0 rgba(0,0,0,0.20), 0 8px 24px -2px rgba(0,0,0,0.45)",
            }}
          >
            <Icon
              name={item.icon}
              size={22}
              className={active ? "text-red" : "text-text"}
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}
            />
          </button>
        );
      })}

      <button
        type="button"
        // Короткий тап — веер, удержание — новая задача по умолчанию, но
        // раздел может подменить действие (27.08.2026, владелец): на
        // «Проектах» держим — заводим проект, на «Дневнике» — заметку,
        // на «Сегодня» — задачу сразу с сегодняшней датой (раньше уходила
        // в /task/new без даты и на этом экране тоже, хотя по короткому
        // тапу с прежним FAB дата подставлялась — расхождение и было
        // причиной жалобы). Everywhere else — без изменений: обычная
        // задача без даты, включая доску (решение 19.08.2026).
        onPointerDown={() => {
          heldRef.current = false;
          if (shineRef.current) {
            shineRef.current.style.transition = "none";
          }
          holdTimer.current = setTimeout(() => {
            heldRef.current = true;
            hapticGrab();
            if (open) toggle(false);
            if (location.pathname === "/projects") {
              navigate("/projects?create=1");
            } else if (location.pathname === "/notes") {
              navigate("/notes?create=1");
            } else if (location.pathname === "/today") {
              navigate("/task/new?due=today");
            } else {
              navigate("/task/new");
            }
          }, HOLD_MS);
        }}
        onPointerMove={(e) => {
          if (shineRef.current) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const moveX = (x / rect.width) * 100 - 50;
            const moveY = (y / rect.height) * 100 - 50;
            shineRef.current.style.transform = `translate(${moveX * 0.4 - 10}%, ${moveY * 0.4 - 10}%)`;
          }
        }}
        onPointerUp={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (shineRef.current) {
            shineRef.current.style.transition = "transform 0.5s ease";
            shineRef.current.style.transform = "translate(-10%, -10%)";
          }
          if (!heldRef.current) toggle(!open);
        }}
        onPointerLeave={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (shineRef.current) {
            shineRef.current.style.transition = "transform 0.5s ease";
            shineRef.current.style.transform = "translate(-10%, -10%)";
          }
        }}
        onPointerCancel={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (shineRef.current) {
            shineRef.current.style.transition = "transform 0.5s ease";
            shineRef.current.style.transform = "translate(-10%, -10%)";
          }
        }}
        aria-expanded={open}
        aria-label={
          open
            ? "Закрыть меню разделов"
            : "Открыть меню разделов, удержание — новая задача"
        }
        // Тёмный полупрозрачный рубиновый кристалл (Dark Ruby Translucent Glass):
        // Благородный глубокий тёмно-красный оттенок в тон тёмной теме,
        // мягкая полупрозрачность с лайтовым размытием текста под кнопкой.
        className="tap-scale fixed left-1/2 z-[36] flex items-center justify-center rounded-full text-white overflow-hidden active:scale-95 select-none"
        style={{
          width: TRIGGER_SIZE,
          height: TRIGGER_SIZE,
          marginLeft: -TRIGGER_SIZE / 2,
          bottom: SAFE_BOTTOM,
          border: "0.5px solid rgba(255, 255, 255, 0.28)",
          background: `
            radial-gradient(ellipse 90% 50% at 50% 0%, rgba(255, 255, 255, 0.35) 0%, rgba(255, 255, 255, 0.08) 45%, transparent 70%),
            linear-gradient(135deg, rgba(185, 30, 22, 0.78) 0%, rgba(135, 18, 12, 0.82) 50%, rgba(85, 10, 8, 0.88) 100%)
          `,
          backdropFilter: "blur(12px) saturate(180%) contrast(105%)",
          WebkitBackdropFilter: "blur(12px) saturate(180%) contrast(105%)",
          boxShadow: `
            inset 0 1.5px 0.5px 0 rgba(255, 255, 255, 0.55),
            inset 0 -1.5px 1px 0 rgba(0, 0, 0, 0.40),
            0 8px 24px -2px rgba(135, 18, 12, 0.50),
            0 4px 12px rgba(0, 0, 0, 0.40)
          `,
          transition:
            "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.3s ease",
          WebkitTapHighlightColor: "transparent",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
      >
        {/* Динамический слой блика (Apple dynamic shine-layer) */}
        <span
          ref={shineRef}
          className="absolute -top-1/2 -left-1/2 w-[200%] h-[200%] pointer-events-none"
          style={{
            background:
              "linear-gradient(135deg, rgba(255, 255, 255, 0) 30%, rgba(255, 255, 255, 0.18) 45%, rgba(255, 255, 255, 0.35) 50%, rgba(255, 255, 255, 0.18) 55%, rgba(255, 255, 255, 0) 70%)",
            transform: "translate(-10%, -10%)",
            willChange: "transform",
          }}
        />

        <span
          ref={iconWrapRef}
          className="relative z-10 inline-flex pointer-events-none"
          style={{
            filter: "drop-shadow(0 1px 3px rgba(0, 0, 0, 0.50))",
          }}
        >
          <Icon name="plus" size={26} />
        </span>
      </button>
    </>
  );
}
