import { Outlet, useLocation } from "react-router-dom";
import { StatusBar, BottomNav, FAB, Panel } from "./UI";
import { useEffect, useState } from "react";

const HIDE_NAV = ["/login", "/register", "/task/new", "/notifications", "/agents", "/projects", "/search"];

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

  /* ── Mobile: full-viewport, no frame ── */
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-bg flex flex-col">
        <div className="flex-1 overflow-y-auto overflow-x-hidden pb-[70px]">
          <Outlet />
        </div>
        {!hideNav && <BottomNav />}
        {!hideFAB && <FAB />}
      </div>
    );
  }

  /* ── Desktop: phone frame + panel ── */
  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center p-4 xl:p-8">
      <div className="flex gap-8 items-start">
        <div className="relative w-[390px] h-[844px] bg-bg rounded-[44px] border border-[#2a2a2a] shadow-[0_0_80px_rgba(0,0,0,.6)] overflow-hidden flex flex-col shrink-0">
          <StatusBar />
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <Outlet />
          </div>
          {!hideNav && <BottomNav />}
          {!hideFAB && <FAB />}
        </div>
        <Panel />
      </div>
    </div>
  );
}
