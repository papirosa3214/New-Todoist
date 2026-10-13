import { AlertCircle, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Раздел 4.10 — ошибки больше не проглатываются.
 * role="alert": ошибку читает экранный диктор сразу.
 */
export function ErrorBanner({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-danger-200 bg-danger-50 p-3",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger-600" aria-hidden="true" />
      <p className="flex-1 text-sm font-medium text-danger-600">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 text-sm font-medium text-danger-600 underline underline-offset-2 hover:text-danger-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Повторить
        </button>
      ) : null}
    </div>
  );
}