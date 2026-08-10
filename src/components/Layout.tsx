import { Outlet, useLocation } from "react-router-dom";
import { StatusBar, BottomNav, FAB, Panel } from "./UI";
import { useEffect, useState } from "react";
import { useCurrentUser } from "../api/auth";
import { useNotificationsSocket } from "../api/ws";

const HIDE_NAV = [
  "/login",
  "/register",
  "/task/new",
  "/notifications",
  "/agents",
  "/projects",
  "/search",
];

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
  const hideNav = HIDE_NAV.some((p) => loc.pathname.startsWith(p));
  const hideFAB = hideNav || loc.pathname.startsWith("/settings");
  const { data: currentUser } = useCurrentUser();
  useNotificationsSocket(!!currentUser);

  /* ── Mobile: full-viewport, no frame ──
     BottomNav and FAB are position:fixed (see UI.tsx) — they pin to the
     real viewport regardless of scroll. That means this wrapper must NOT
     also try to own a nested `overflow-y-auto` scroll region: measured on
     a real page (via CDP against the live dev server), a flex column whose
     height comes only from `min-height` (not a definite `height`) does NOT
     reliably cap a `flex-1 overflow-y-auto` child — the browser instead
     grows the whole column past the viewport and the DOCUMENT scrolls,
     dragging every "fixed-looking" flex sibling along with it. Letting the
     page scroll normally (no nested overflow container here) sidesteps
     that failure mode entirely; pb-content-safe on the content reserves
     room so the last row isn't hidden behind the fixed nav. */
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-bg overflow-x-clip">
        <div className="pb-content-safe">
          <Outlet />
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
