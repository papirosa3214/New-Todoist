// Шит уборки лишних чатов (карточка 0b7a8b81…, 21.10.2026).
//
// Что делает: показывает, сколько в приложении пустых тем задач и какие
// именно, и — только после подтверждения — убирает их из общего списка.
// Убранный чат не стирается: строка остаётся в базе, история и статистика
// по задаче — на месте, а в карточке задачи чат остаётся видимым.
//
// Отбор — на сервере (GET /api/chats/cleanup/candidates): пустые темы задач,
// которые не трогали два часа и у которых нет живых попыток. Клиент только
// показывает список и спрашивает подтверждение.
//
// Каркас шторки — тот же useBottomSheet, что у CreateChatSheet: scrim +
// bg-card rounded-sheet-top + SheetHandle.

import { useState } from "react";
import {
  Button,
  ErrorBanner,
  Icon,
  Loading,
  SheetHandle,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useBottomSheet } from "../lib/useBottomSheet";
import {
  useChatCleanupCandidates,
  useRunChatCleanup,
} from "../api/chats";
import { formatAbsoluteTime } from "../lib/date";

export function ChatCleanupSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const sheet = useBottomSheet({ open, onClose });
  const { confirm, dialog } = useDialog();
  const {
    data,
    isLoading,
    isError,
    error,
  } = useChatCleanupCandidates(open);
  const cleanup = useRunChatCleanup();
  const [done, setDone] = useState<number | null>(null);

  const candidates = data?.chats ?? [];
  const count = data?.count ?? 0;

  const handleClose = () => {
    onClose();
    queueMicrotask(() => setDone(null));
  };

  const run = async () => {
    if (count === 0 || cleanup.isPending) return;
    const ok = await confirm({
      title: `Убрать ${count} ${pluralChats(count)}?`,
      description:
        "Чаты уйдут из общего списка, но останутся в базе и в карточках своих задач. История и статистика не пострадают.",
      confirmLabel: "Убрать",
      cancelLabel: "Отмена",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await cleanup.mutateAsync();
      setDone(res.archived);
    } catch {
      // Ошибка — в mutation.error, её покажет ErrorBanner ниже.
    }
  };

  if (!sheet.mounted) return null;

  return (
    <div
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={handleClose}
    >
      {dialog}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={handleClose}
            aria-label="Закрыть"
            className="w-[44px] h-[44px] -ml-2.5 flex items-center justify-center text-sub"
          >
            <Icon name="close" size={20} />
          </button>
          <h3 className="tf-title">Уборка чатов</h3>
          <div className="w-[44px] h-[44px]" />
        </div>

        {isLoading && <Loading variant="block" />}
        <ErrorBanner
          error={isError ? error : null}
          fallback="Не удалось получить список лишних чатов."
        />

        {!isLoading && !isError && done === null && (
          <>
            <p className="tf-action text-sub mb-3 px-1">
              {count === 0
                ? "Лишних чатов нет — убирать нечего."
                : `Найдено ${count} ${pluralChats(count)}: пустые темы задач, которые давно не трогали. В них нет ни сообщений, ни живых ходов.`}
            </p>

            {count > 0 && (
              <ul className="flex flex-col gap-1 mb-4">
                {candidates.map((c) => (
                  <li
                    key={c.id}
                    className="bg-card2 rounded-xl px-3.5 py-2.5 flex items-baseline justify-between gap-3"
                  >
                    <span className="tf-action text-text truncate">
                      {c.task_title || c.title || "Тема задачи"}
                    </span>
                    <span className="tf-meta text-dim shrink-0 tabular-nums">
                      {formatAbsoluteTime(c.updated_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <ErrorBanner
              error={cleanup.error}
              fallback="Не удалось убрать лишние чаты."
            />

            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                onClick={run}
                disabled={count === 0 || cleanup.isPending}
              >
                {cleanup.isPending
                  ? "Убираем…"
                  : count === 0
                    ? "Убирать нечего"
                    : `Убрать ${count} ${pluralChats(count)}`}
              </Button>
              <Button variant="secondary" onClick={handleClose}>
                Закрыть
              </Button>
            </div>
          </>
        )}

        {done !== null && (
          <>
            <p className="tf-action text-sub mb-4 px-1">
              Убрано {done} {pluralChats(done)}. Чаты остались в базе и в
              карточках своих задач.
            </p>
            <Button variant="primary" onClick={handleClose}>
              Готово
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** 1 чат, 2-4 чата, 5+ чатов — чтобы не писать «1 чатов». */
function pluralChats(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "чатов";
  const mod10 = n % 10;
  if (mod10 === 1) return "чат";
  if (mod10 >= 2 && mod10 <= 4) return "чата";
  return "чатов";
}
