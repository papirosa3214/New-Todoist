// ═══════════ CONFIRM / ALERT — replacement for window.confirm()/alert() ═══════════
// A native confirm()/alert() is a browser-chrome dialog — it looks nothing
// like the app and breaks the dark mobile UI. This is the app's own bottom
// sheet, same visual language as mockup-reference/index.html's own
// .overlay/.sheet modal (lines 284-306): black scrim, sheet slides up from
// the bottom, tapping the scrim dismisses. One deliberate deviation from
// the mockup: its .x-btn is 34px square — under Максим's 44px tap-target
// floor — so this has no x-btn at all; the two full-width Button rows
// (already h-12/48px) are both the action and the obvious way to close it.
//
// Usage — replaces `if (!confirm("...")) return;`:
//
//   const { confirm, dialog } = useDialog();
//   ...
//   const handleDelete = async () => {
//     const ok = await confirm({
//       title: "Удалить задачу без возможности отмены?",
//       confirmLabel: "Удалить",
//       danger: true,
//     });
//     if (!ok) return;
//     deleteTask.mutate(task.id, { onSuccess: () => navigate(-1) });
//   };
//   return (
//     <div>
//       {dialog}
//       ...
//     </div>
//   );
//
// Usage — replaces `alert("...")`:
//
//   const { alert, dialog } = useDialog();
//   ...
//   await alert("Не удалось удалить задачу — возможно, вы не создатель этой задачи.");
//
// `{dialog}` only needs to be mounted once per screen, anywhere in its
// returned JSX (it renders `fixed inset-0`, so position in the tree
// doesn't matter) — `confirm()`/`alert()` are what actually open it.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Icon } from "./UI";
import { useBottomSheet } from "../lib/useBottomSheet";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the description coral and shows a warning icon — use for
   *  destructive actions (delete task/project/label, …). */
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  description?: string;
  okLabel?: string;
}

type DialogState =
  ({ mode: "confirm" } & ConfirmOptions) | ({ mode: "alert" } & AlertOptions);

export function useDialog(): {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  alert: (opts: AlertOptions | string) => Promise<void>;
  dialog: ReactNode;
} {
  const [state, setState] = useState<DialogState | null>(null);
  // open=true when state is non-null — drives useBottomSheet
  const [open, setOpen] = useState(false);
  // The pending resolver lives in a ref, not in `state` — it must survive
  // untouched across the re-render `setState` triggers, and never itself
  // becomes a reason to re-render.
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setState(null);
    setOpen(false);
  }, []);

  // A screen can unmount (navigate away) while its dialog is still open —
  // an unsettled `await confirm(...)` would hang forever and leak the
  // promise. Resolve it as "cancelled" on unmount.
  useEffect(() => {
    return () => {
      resolveRef.current?.(false);
      resolveRef.current = null;
    };
  }, []);

  const confirm = useCallback((opts: ConfirmOptions | string) => {
    const normalized: ConfirmOptions =
      typeof opts === "string" ? { title: opts } : opts;
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState({ mode: "confirm", ...normalized });
      setOpen(true);
    });
  }, []);

  const alert = useCallback((opts: AlertOptions | string) => {
    const normalized: AlertOptions =
      typeof opts === "string" ? { title: opts } : opts;
    return new Promise<void>((resolve) => {
      resolveRef.current = () => resolve();
      setState({ mode: "alert", ...normalized });
      setOpen(true);
    });
  }, []);

  // useBottomSheet drives slide-up / slide-down animation.
  // No drag-to-dismiss: confirm dialogs must not be accidentally dismissed.
  const sheet = useBottomSheet({ open, onClose: () => settle(false) });

  const dialog: ReactNode = sheet.mounted && state && (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={() => settle(false)}
    >
      {/* Scrim: opacity animated by useBottomSheet spring */}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-5 pt-6 pb-bottom-safe"
        onClick={(e) => e.stopPropagation()}
      >
        {state.mode === "confirm" && state.danger && (
          <div className="w-11 h-11 rounded-full bg-coral/15 flex items-center justify-center mx-auto mb-3">
            <Icon name="trash" size={20} className="text-coral" />
          </div>
        )}
        <h3 className="text-[17px] font-semibold text-center mb-1">
          {state.title}
        </h3>
        {state.description && (
          <p
            className={`text-[14px] text-center leading-relaxed mb-5 ${
              state.mode === "confirm" && state.danger
                ? "text-coral"
                : "text-sub"
            }`}
          >
            {state.description}
          </p>
        )}
        {!state.description && <div className="mb-4" />}
        <div className="flex flex-col gap-2">
          {state.mode === "confirm" ? (
            <>
              <Button variant="primary" onClick={() => settle(true)}>
                {state.confirmLabel ?? "ОК"}
              </Button>
              <Button variant="secondary" onClick={() => settle(false)}>
                {state.cancelLabel ?? "Отмена"}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => settle(true)}>
              {state.okLabel ?? "Понятно"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return { confirm, alert, dialog };
}
