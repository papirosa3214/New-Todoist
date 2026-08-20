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
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
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
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open, anchorRef]);

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
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={panelRef}
        role="menu"
        style={{
          top: pos.top,
          right: pos.right,
          opacity: 0,
          transform: "scale(0.95) translateZ(0)",
        }}
        className="fixed z-50 min-w-[192px] max-w-[calc(100vw-32px)] origin-top-right overflow-hidden rounded-2xl border border-stroke bg-card2 shadow-pop"
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
