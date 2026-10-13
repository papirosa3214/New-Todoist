import { cn } from "@/lib/utils";

/**
 * Раздел 4.2 — заголовок экрана, пояснение и основное действие.
 * Десктоп: строка с центрированием. Телефон: вертикальный стек,
 * действие во всю ширину под заголовком.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Фильтры, селектор периода и чипы — под заголовком. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold leading-8 text-ink-900">{title}</h1>
          {description ? (
            <p className="mt-1 text-base text-ink-500">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-col gap-2 sm:flex-row">{actions}</div>
        ) : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}