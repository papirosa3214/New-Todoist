import { cn } from "@/lib/utils";

/** Раздел 4.12: единственный способ обозначить загрузку. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-ink-200", className)}
      {...props}
    />
  );
}

export { Skeleton };