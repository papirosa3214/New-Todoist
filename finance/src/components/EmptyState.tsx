import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Раздел 4.9 — обязателен везде, где может быть пусто. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-4 py-12 text-center", className)}>
      {Icon ? <Icon className="mb-3 h-12 w-12 text-ink-300" aria-hidden="true" /> : null}
      <h2 className="text-lg font-semibold leading-7 text-ink-900">{title}</h2>
      <p className="mt-1 max-w-sm text-base text-ink-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}