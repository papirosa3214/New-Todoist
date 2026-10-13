"use client";

import { Button } from "@/components/ui/button";

/** Раздел 4.12 — ошибка загрузки отдельным экраном с кнопкой повтора. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-sm rounded-xl border border-ink-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold leading-7 text-ink-900">Не удалось загрузить</h1>
        <p className="mt-1 text-base text-ink-500">
          Что-то пошло не так на сервере. Данные не изменились.
        </p>
        <Button className="mt-4 w-full" onClick={() => reset()}>
          Попробовать снова
        </Button>
      </div>
    </div>
  );
}