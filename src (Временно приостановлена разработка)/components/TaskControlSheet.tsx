// ═══════════ TASK CONTROL SHEET — причина для «прервать / сбросить / отменить» ═══════════
// Шторка причины для трёх ручек MAK-69. Визуально 1-в-1 с ReturnToWorkSheet
// (TaskJournal.tsx) — тот же bg-card, та же шапка с «X» / «✓», тот же
// useBottomSheet со всеми iOS-фиксами (--vv-top/--vv-height, --kb-height,
// preventDefault на mousedown). Конкретные отличия от ReturnToWorkSheet:
//
// 1. Без микрофона (useMicRecorder / useTranscribeAudio / MicKeyboardBar /
//    MicOverlay) — причина это служебная строка для журнала, её не
//    надиктовывают; подсказка «есть поле — есть микрофон» здесь была бы
//    ложной.
//
// 2. Три `kind` (`cancel_subtask` / `reset_subtask` / `cancel_task`) —
//    одна шторка на все три действия, выбор через пропс.
//
// 3. `value.trim()` НЕ блокирует submit (как у ReturnToWorkSheet). Сервер
//    сам подставит «принудительная остановка» (control.ts:256-258 для
//    cancel/reset, 322-324 для cancelTaskWork), и UI подталкивает: пустая
//    причина — валидный ввод, «отменить задание» не должно ломаться из-за
//    нежелания владельца ничего писать.
//
// 4. Заголовок и подсказка приходят снаружи (через `title` и `hint`),
//    чтобы вызывающий код подбирал слова под контекст. Здесь — дефолты
//    на каждый kind, чтобы одиночные вызовы выглядели одинаково.
import { useEffect, useState } from "react";
import { ErrorBanner, Icon, SheetHandle } from "./UI";
import { useBottomSheet } from "../lib/useBottomSheet";
import {
  useCancelSubtask,
  useResetSubtask,
  useCancelTask,
} from "../api/control";

export type TaskControlKind =
  | "cancel_subtask"
  | "reset_subtask"
  | "cancel_task";

const TITLES: Record<TaskControlKind, string> = {
  cancel_subtask: "Прервать шаг",
  reset_subtask: "Сбросить попытку",
  cancel_task: "Отменить задание",
};

const HINTS: Record<TaskControlKind, string> = {
  cancel_subtask:
    "Шаг остановится, текущая попытка закроется. Сервер запишет причину в журнал.",
  reset_subtask:
    "Попытка шага закроется без вызова остановки — пригодится, если процесс агента уже не в памяти.",
  cancel_task:
    "Все активные запуски задачи и все попытки шагов закроются разом. Задача будет готова к новому запуску.",
};

const PLACEHOLDERS: Record<TaskControlKind, string> = {
  cancel_subtask:
    "Например: завис на импорте, перезапусти с чистого листа…",
  reset_subtask: "Например: lease истёк, а процесса уже нет…",
  cancel_task: "Например: передумал, останови всё…",
};

export function TaskControlSheet({
  open,
  onClose,
  kind,
  subtaskId,
  taskId,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  kind: TaskControlKind;
  /** Для cancel_subtask / reset_subtask. */
  subtaskId?: string;
  /** Для cancel_task; для остальных берётся из подзадачи, не нужен. */
  taskId?: string;
  /** Зовётся один раз при успехе мутации — после закрытия шторки. */
  onSuccess?: () => void;
}) {
  // Тот же хук и тот же «mount → rAF → slide up» контракт, что у
  // ReturnToWorkSheet — никаких «почти таких же» шитов: правки iOS-фиксов
  // (--vv-top/--vv-height, --kb-height) живут в useBottomSheet и в
  // ReturnToWorkSheet, и эта шторка их просто наследует.
  const sheet = useBottomSheet({ open, onClose });

  const cancelSubtask = useCancelSubtask();
  const resetSubtask = useResetSubtask();
  const cancelTask = useCancelTask();

  const mutation =
    kind === "cancel_subtask"
      ? cancelSubtask
      : kind === "reset_subtask"
        ? resetSubtask
        : cancelTask;

  const [value, setValue] = useState("");

  // Успех: шторка закрывается, onSuccess — после закрытия. Шторка сама
  // закрывается onClose → useBottomSheet анимирует спринг вниз, и только
  // потом отдаёт setMounted(false); onSuccess должен зваться в этом окне,
  // когда анимация уже пошла, иначе родительский стейт («меню закрыто»)
  // перерисует DOM под ещё видимым шитом.
  useEffect(() => {
    if (mutation.isSuccess) {
      onSuccess?.();
      setValue("");
      onClose();
    }
    // mutation.isSuccess намеренно один: пересобираем эффект только при
    // смене kind, чтобы одна успешная мутация не закрыла шторку повторно
    // (успех сбрасывается в false на следующем reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutation.isSuccess, kind]);

  // Сброс причины при смене вида или при новом открытии — чтобы текст
  // прошлой отмены не прилипал к следующему действию.
  useEffect(() => {
    if (open) setValue("");
  }, [open, kind]);

  if (!sheet.mounted) return null;

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (kind === "cancel_subtask" && subtaskId) {
      cancelSubtask.mutate({ id: subtaskId, reason: trimmed || undefined });
    } else if (kind === "reset_subtask" && subtaskId) {
      resetSubtask.mutate({ id: subtaskId, reason: trimmed || undefined });
    } else if (kind === "cancel_task" && taskId) {
      cancelTask.mutate({ id: taskId, reason: trimmed || undefined });
    }
  };

  return (
    <div
      className="fixed left-0 right-0 z-50 flex flex-col justify-end"
      onClick={onClose}
      // Те же --vv-top / --vv-height, что у ReturnToWorkSheet: фикс iOS
      // (см. подробный комментарий там же — одна и та же история, в этой
      // шторке без микрофона, но клавиатура по-прежнему открывается по
      // autoFocus на textarea, и физически жить над ней она должна).
      style={{
        top: "var(--vv-top, 0px)",
        height: "var(--vv-height, 100dvh)",
      }}
    >
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4"
        onClick={(e) => e.stopPropagation()}
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
        }}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-2">
          <button
            type="button"
            // preventDefault на mousedown — тот же приём, что у X/✓ в
            // ReturnToWorkSheet, по той же причине (тап при открытой
            // клавиатуре иначе уезжает под тапом между touchstart и
            // touchend).
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            aria-label="Отмена"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={18} className="text-sub" />
          </button>
          <h3 className="tf-title text-text">{TITLES[kind]}</h3>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleSubmit}
            // busy блокирует submit, value.trim() — НЕ блокирует: причина
            // необязательна (см. шапку файла, пункт 3). Это единственное
            // место в проекте, где submit-кружок «✓» активна на пустом
            // поле, и это сделано намеренно.
            disabled={mutation.isPending}
            aria-label="Отправить"
            className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-white" />
          </button>
        </div>
        <p className="tf-action text-sub mb-2 px-1">{HINTS[kind]}</p>
        <ErrorBanner
          error={mutation.error}
          fallback="Не удалось отправить — попробуйте ещё раз"
          variant="block"
          className="mb-2"
        />
        <textarea
          autoFocus
          // rows=3 (а не 4 как у ReturnToWorkSheet): здесь причина, не
          // полноценный комментарий агенту — объёма меньше, и более
          // высокая шторка занимала бы пол-экрана без пользы.
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={PLACEHOLDERS[kind]}
          className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none resize-none mb-3"
        />
      </div>
    </div>
  );
}
