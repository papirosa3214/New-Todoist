"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Дашборд" },
  { href: "/operations", label: "Операции" },
  { href: "/import", label: "Импорт" },
  { href: "/accounts", label: "Счета" },
  { href: "/categories", label: "Категории" },
];

export function Sidebar({ username }: { username: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="w-56 bg-white border-r border-ink-200 flex flex-col">
      <div className="px-5 py-5 border-b border-ink-200">
        <div className="text-base font-semibold">Финансы</div>
        <div className="text-xs text-ink-500">@{username}</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {items.map((it) => {
          const active = pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`block px-3 py-2 rounded-md text-sm ${
                active
                  ? "bg-accent-500/10 text-accent-700 font-medium"
                  : "text-ink-700 hover:bg-ink-100"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-3 border-t border-ink-200">
        <button
          onClick={logout}
          className="text-sm text-ink-600 hover:text-ink-900"
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}