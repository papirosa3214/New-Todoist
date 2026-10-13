"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  List,
  Plus,
  Wallet,
  Menu,
  MoreHorizontal,
  Upload,
  Tags,
  LogOut,
  ArrowLeft,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Дашборд", icon: LayoutDashboard },
  { href: "/operations", label: "Операции", icon: List },
  { href: "/accounts", label: "Счета", icon: Wallet },
];

const SECONDARY: NavItem[] = [
  { href: "/import", label: "Импорт", icon: Upload },
  { href: "/categories", label: "Категории", icon: Tags },
];

const SCREEN_TITLES: Array<[string, string]> = [
  ["/dashboard", "Дашборд"],
  ["/operations/new", "Новая операция"],
  ["/operations", "Операции"],
  ["/accounts", "Счета"],
  ["/categories", "Категории"],
  ["/import", "Импорт"],
];

/**
 * Раздел 4.1 — каркас с адаптивной навигацией.
 * ≥1024: постоянный сайдбар 240 px. <1024: верхняя и нижняя панели,
 * меню открывается одним Sheet (бургер и «Ещё» ведут в него же).
 */
export function AppShell({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = React.useState<"all" | "more" | null>(null);

  const screenTitle =
    SCREEN_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Финансы";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  function isActive(href: string) {
    if (href === "/operations") {
      return pathname.startsWith("/operations");
    }
    return pathname.startsWith(href);
  }

  const navLinkClass = (active: boolean) =>
    cn(
      "flex min-h-11 items-center gap-3 rounded-md px-3 text-base transition-colors",
      active ? "bg-accent-50 font-medium text-accent-700" : "text-ink-700 hover:bg-ink-100",
    );

  return (
    <div className="flex min-h-screen bg-ink-50">
      {/* Сайдбар только на широких экранах */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="border-b border-ink-200 px-5 py-5">
          <div className="text-lg font-semibold leading-7 text-ink-900">Финансы</div>
          <div className="text-xs text-ink-500">@{username}</div>
        </div>
        <nav className="flex-1 space-y-1 px-2 py-3">
          {[...PRIMARY, ...SECONDARY].map((it) => (
            <Link key={it.href} href={it.href} className={navLinkClass(isActive(it.href))}>
              <it.icon className="h-5 w-5 shrink-0" />
              {it.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-ink-200 px-5 py-3">
          <Button variant="ghost" size="sm" className="w-full justify-start px-0" onClick={logout}>
            Выйти
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Верхняя панель только на узких экранах */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-ink-200 bg-white lg:hidden">
          <Sheet open={menu === "all"} onOpenChange={(open) => setMenu(open ? "all" : null)}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Открыть меню">
                <Menu className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="pb-[max(1rem,env(safe-area-inset-bottom))]">
              <SheetHeader>
                <SheetTitle>Меню</SheetTitle>
              </SheetHeader>
              <nav className="space-y-1">
                {[...PRIMARY, ...SECONDARY].map((it) => (
                  <Link
                    key={it.href}
                    href={it.href}
                    onClick={() => setMenu(null)}
                    className={navLinkClass(isActive(it.href))}
                  >
                    <it.icon className="h-5 w-5 shrink-0" strokeWidth={1.75} />
                    {it.label}
                  </Link>
                ))}
                <Button
                  variant="ghost"
                  className="w-full justify-start px-3 text-ink-700"
                  onClick={() => {
                    setMenu(null);
                    void logout();
                  }}
                >
                  <LogOut className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  Выйти
                </Button>
              </nav>
            </SheetContent>
          </Sheet>

          <div className="flex-1 truncate text-center text-lg font-semibold leading-7 text-ink-900">
            {screenTitle}
          </div>

          <div className="flex w-11 justify-end pr-1">
            {pathname.startsWith("/operations") &&
            !pathname.startsWith("/operations/new") ? (
              <Button variant="ghost" size="icon" asChild aria-label="Новая операция">
                <Link href="/operations/new">
                  <Plus className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </div>
        </header>

        <main className="min-w-0 flex-1 pb-24 lg:pb-0">{children}</main>

        {/* Нижняя панель только на узких экранах */}
        <nav
          aria-label="Основная навигация"
          className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          {PRIMARY.slice(0, 2).map((it) => (
            <BottomLink key={it.href} item={it} active={isActive(it.href)} />
          ))}
          <div className="flex w-16 shrink-0 items-start justify-center">
            <Button
              asChild
              size="icon"
              className="-mt-5 h-14 w-14 rounded-full bg-accent-600 text-white hover:bg-accent-700"
            >
              <Link href="/operations/new" aria-label="Новая операция">
                <Plus className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
              </Link>
            </Button>
          </div>
          <BottomLink item={PRIMARY[2]} active={isActive(PRIMARY[2].href)} />
          <Sheet open={menu === "more"} onOpenChange={(open) => setMenu(open ? "more" : null)}>
            <SheetTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium",
                  pathname === "/import" || pathname === "/categories"
                    ? "text-accent-700"
                    : "text-ink-500",
                )}
              >
                <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                Ещё
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="pb-[max(1rem,env(safe-area-inset-bottom))]">
              <SheetHeader>
                <SheetTitle>Ещё</SheetTitle>
              </SheetHeader>
              <div className="space-y-1">
                {SECONDARY.map((it) => (
                  <Link
                    key={it.href}
                    href={it.href}
                    onClick={() => setMenu(null)}
                    className={navLinkClass(isActive(it.href))}
                  >
                    <it.icon className="h-5 w-5 shrink-0" strokeWidth={1.75} />
                    {it.label}
                  </Link>
                ))}
                <Link
                  href="/operations"
                  onClick={() => setMenu(null)}
                  className={navLinkClass(isActive("/operations"))}
                >
                  <ArrowLeft className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                  Все операции
                </Link>
                <Button
                  variant="ghost"
                  className="w-full justify-start px-3 text-ink-700"
                  onClick={() => {
                    setMenu(null);
                    void logout();
                  }}
                >
                  <LogOut className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  Выйти
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </nav>
      </div>
    </div>
  );
}

function BottomLink({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  return (
    <Link
      href={item.href}
      className={cn(
        "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium",
        active ? "text-accent-700" : "text-ink-500",
      )}
    >
      <item.icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
      {item.label}
    </Link>
  );
}