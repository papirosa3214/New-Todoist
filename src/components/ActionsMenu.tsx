// ═══════════ ACTIONS MENU (dropdown) ═══════════
// Small dropdown menu anchored to its trigger button, replacing the old
// full-screen bottom sheets (ActionsSheet.tsx / TaskActionsSheet.tsx —
// both removed). Owner's direct complaint about the sheets: "эти три
// точки будут вот так вот снизу, какая-то мура происходить. Я думал,
// аккуратненько окошко будет сверху и появляться, чтобы я там и выбрал."
// So: no scrim, no full-width panel — a content-width card that opens
// right under the trigger, aligned to its right edge.
//
// Both the panel and its click-outside catcher are portaled to
// document.body and positioned with `position: fixed` from the trigger's
// live getBoundingClientRect() — not rendered inline next to the trigger
// with CSS `absolute`. Two real bugs found live while wiring this up
// forced that:
//   1. ScreenHeader's own wrapper carries `backdrop-blur-xl`, and per spec
//      an ancestor with backdrop-filter becomes the containing block for
//      `position: fixed` descendants. An inline "fixed inset-0" catcher
//      was confined to the header's own small box instead of the full
//      viewport, so taps below the header never reached it and the menu
//      never closed.
//   2. ScreenHeader is also `position: sticky` with its own z-20, which
//      opens a stacking context — a menu panel nested inside it can't
//      out-rank a sibling of that header even with a bigger z-index
//      number. Once the catcher above was portaled to <body> (so it could
//      actually reach the whole viewport), it started painting *over* the
//      still-inline menu panel, eating its own item clicks.
// Portaling both to <body> puts them in the same stacking context, so
// z-40/z-50 between them means what it says. Needs `anchorRef` — a ref on
// the trigger button — to know where to sit.
//
// §3 Apple Design (Interruptibility): open/close animation driven by
// useSpring instead of CSS transition. Re-opening while closing picks up
// from the current opacity/scale without jumps.
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./UI";
import { useSpring } from "../lib/useSpring";

export type ActionsMenuItem = {
  icon: string;
  label: ReactNode;
  onClick: () => void;
  destructive?: boolean;
};

export function ActionsMenu({
  open,
  onClose,
  items,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  items: ActionsMenuItem[];
  /** Ref on the trigger button — the menu anchors to its bottom-right. */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [mounted, setMounted] = useState(open);
  // top ИЛИ bottom — какой стороной меню приклеено к кнопке. Держать обе
  // нельзя: приклеенная сторона и есть та, от которой меню растёт.
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    maxHeight: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Spring drives opacity + scale directly on the panel DOM node.
  // Fully interruptible: if the user closes and immediately reopens,
  // the spring redirects from the current value without snapping.
  // response:0.2 → quick, snappy appearance matching the small size of the menu.
  const spring = useSpring(
    (value, done) => {
      const el = panelRef.current;
      if (el) {
        el.style.opacity = String(value);
        el.style.transform = `scale(${0.95 + 0.05 * value}) translateZ(0)`;
      }
      // Unmount after the close animation finishes
      if (!open && done && value < 0.02) {
        setMounted(false);
      }
    },
    { response: 0.2, damping: 1 },
  );

  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // Opened
      setMounted(true);
    }
    if (!open && prevOpenRef.current) {
      // Closed — animate out
      spring.animateTo(0);
    }
    prevOpenRef.current = open;
  }, [open, spring]);

  // When the panel first mounts (or re-mounts), animate in from 0 → 1
  const prevMountedRef = useRef(mounted);
  useEffect(() => {
    if (mounted && !prevMountedRef.current) {
      spring.set(0);
      requestAnimationFrame(() => spring.animateTo(1));
    }
    prevMountedRef.current = mounted;
  }, [mounted, spring]);

  // Runs before paint, synchronously — so the panel appears already
  // anchored in the right place on the very first frame instead of
  // flashing at (0,0) for a tick.
  useLayoutEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    // Куда раскрываться. Раньше меню всегда падало ВНИЗ — годилось, пока
    // все его кнопки жили в шапке. С кнопкой у нижней кромки (выбор
    // адресата в строке ввода чата, 28.08.2026) оно уезжало за экран
    // целиком, и владелец видел пустоту.
    //
    // Высота прикидывается по числу пунктов (строка меню — min-h-[44px]),
    // и точность тут не критична: при развороте вверх меню приклеено
    // СНИЗУ, поэтому ошибка в прикидке двигает не край у кнопки, а
    // дальний край — за экран он всё равно не уйдёт, его держит maxHeight.
    const GAP = 6;
    const EDGE = 8;
    const guess = items.length * 44 + 2;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const flip = below < guess && above > below;

    // Какой стороной цепляться по горизонтали. Меню всегда цеплялось
    // ПРАВЫМ краем — верно для кнопки «три точки», которая стоит справа.
    // Кнопка адресата в строке ввода чата стоит СЛЕВА (x=16), и от неё
    // меню шириной 192 уезжало за левый край экрана: на снимке было видно
    // обрезанные пункты, вылезающие из-за кромки. Сторона выбирается по
    // тому, в какой половине экрана стоит кнопка.
    const anchorLeft = r.left + r.width / 2 < window.innerWidth / 2;
    const side = anchorLeft
      ? { left: r.left }
      : { right: window.innerWidth - r.right };

    setPos(
      flip
        ? { bottom: window.innerHeight - r.top + GAP, ...side, maxHeight: above }
        : { top: r.bottom + GAP, ...side, maxHeight: below },
    );
  }, [open, anchorRef, items.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!mounted || !pos) return null;

  return createPortal(
    <>
      {/* Click-outside catcher — deliberately transparent, this is a menu
          not a modal, so the rest of the screen must stay visible and
          undimmed. */}
      <div
        // Свайп «назад» не должен уводить экран из-под шторки
        // (useSwipeBack ищет этот атрибут).
        data-overlay
        className="fixed inset-0 z-40"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="menu"
        style={{
          top: pos.top,
          bottom: pos.bottom,
          left: pos.left,
          right: pos.right,
          maxHeight: pos.maxHeight,
          opacity: 0,
          transform: "scale(0.95) translateZ(0)",
        }}
        // origin — та сторона, которой меню приклеено к кнопке: пружина
        // масштаба должна выращивать его ИЗ кнопки, а не из дальнего угла.
        // overflow-y-auto (было overflow-hidden): длинный список пунктов
        // упирается в maxHeight и прокручивается, а не обрезается.
        // Имена классов ЦЕЛИКОМ, а не собранные из кусков: Tailwind ищет
        // их в исходнике текстом, и `"origin-" + x` он не увидит — стиля
        // просто не будет в сборке.
        className={`fixed z-50 min-w-[192px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl border border-stroke bg-card2 shadow-pop ${
          pos.bottom === undefined
            ? pos.left === undefined
              ? "origin-top-right"
              : "origin-top-left"
            : pos.left === undefined
              ? "origin-bottom-right"
              : "origin-bottom-left"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="divide-y divide-stroke">
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => {
                onClose();
                item.onClick();
              }}
              className={`tap-row flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left text-[14px] ${
                item.destructive ? "text-coral" : "text-text"
              }`}
            >
              <Icon
                name={item.icon}
                size={16}
                className={item.destructive ? "text-coral" : "text-sub"}
              />
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
