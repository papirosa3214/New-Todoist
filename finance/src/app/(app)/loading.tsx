import { Skeleton } from "@/components/ui/skeleton";

/** Раздел 4.12 — уход со страницы обозначается скелетоном, а не пустотой. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <Skeleton className="h-8 w-56" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-ink-200 bg-white p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-7 w-40" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-ink-200 bg-white p-5">
            <Skeleton className="h-4 w-32" />
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}