// ═══════════ SYNCHRONOUS DOUBLE-TAP GUARD ═══════════
//
// The bug this fixes: guarding a submit button with `disabled={isPending}`
// (or any local `useState`) is a *React state* guard — it only takes effect
// on the next render. A fast double-tap fires two real click/submit events
// before that render commits, so both get through and both fire the
// mutation (duplicate tasks/comments/projects/labels — exactly the bug
// report this hook exists to close). A `useRef` guard has no such gap: the
// lock is read and set synchronously, in the same tick the event handler
// runs, before React (or the network) gets involved at all.
//
// The lock stays held for the *entire* duration of the wrapped call,
// including any awaited promise — so for real protection the wrapped
// function must return that promise. In practice that means calling
// `mutation.mutateAsync(...)` inside the guarded callback, not
// `mutation.mutate(...)`: `.mutate()` is fire-and-forget and returns
// nothing to await, so wrapping it still blocks same-tick re-entrancy but
// gives no protection across the actual network round-trip. `.mutateAsync`
// is what makes the lock cover the request.
//
// One hook call == one independently-guarded action. A row rendered in a
// `.map()` (a subtask row, a comment's delete button, …) needs its own
// `useGuardedCallback` per row instance — don't hoist a single guard out of
// the loop and share it across rows, or tapping row 2 while row 1's request
// is in flight will silently no-op.
import { useCallback, useRef } from "react";

export function useGuardedCallback<Args extends unknown[]>(
  fn: (...args: Args) => unknown | Promise<unknown>,
  options?: { onError?: (error: unknown) => void },
): (...args: Args) => Promise<void> {
  const busyRef = useRef(false);
  // Kept in refs (not the useCallback dep array) so the returned function
  // has a stable identity across renders while still always calling the
  // latest `fn`/`onError` closures — no stale-closure bugs, no need for the
  // caller to memoize `fn` themselves.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  return useCallback(async (...args: Args) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await fnRef.current(...args);
    } catch (err) {
      // No onError handler → let it propagate. React Query's own mutation
      // state (`.error`/`.isError`) is already populated by this point
      // regardless of whether anyone awaits/catches the rejection, so
      // pairing this with <ErrorBanner error={mutation.error} /> needs no
      // try/catch at the call site at all. Pass onError only when the
      // action isn't itself a tracked mutation (e.g. a raw `api.*` call)
      // and you need somewhere to put the error.
      if (onErrorRef.current) onErrorRef.current(err);
      else throw err;
    } finally {
      busyRef.current = false;
    }
  }, []);
}
