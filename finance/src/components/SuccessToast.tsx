"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Toast = { id: number; text: string };

const ToastContext = React.createContext<(text: string) => void>(() => undefined);

/** Раздел 4.11 — подтверждение действия, роль status (не alert). */
export function SuccessToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);

  const notify = React.useCallback((text: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 max-md:bottom-28"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "animate-toast-in rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white shadow-sm",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useSuccessToast() {
  return React.useContext(ToastContext);
}