// ═══════════ HUMAN-READABLE MUTATION/QUERY ERRORS ═══════════
// Turns whatever a failed request threw (ApiError, a bare fetch TypeError
// from being offline, some other Error, or an already-extracted string)
// into one Russian sentence fit for <ErrorBanner> (see ../components/UI).
import { ApiError } from "../api/client";

const DEFAULT_FALLBACK = "Что-то пошло не так. Попробуйте ещё раз.";

// The server's error strings are a mix of Russian validation messages
// ("Укажите название проекта" — fine to show as-is) and English technical
// ones ("Not found", "invalid project_id", and `res.statusText` for
// anything the route didn't set explicitly — never fine, breaks "все
// тексты для пользователя — по-русски"). There's no reliable way to tell
// those apart from the status code alone, so this gates on script instead:
// only pass a message through if it actually contains Cyrillic, otherwise
// use the caller's fallback.
const CYRILLIC = /[а-яёА-ЯЁ]/;

function localizedOrFallback(message: string | undefined, fallback: string) {
  return message && CYRILLIC.test(message) ? message : fallback;
}

// `fallback` should be a specific, Russian, one-sentence description of
// what failed ("Не удалось сохранить задачу") — pass it explicitly at
// every call site rather than relying on the generic default below, which
// exists only so the signature degrades gracefully if you don't.
export function getErrorMessage(
  error: unknown,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (error === null || error === undefined || error === false) return "";
  if (typeof error === "string") return error;
  if (error instanceof ApiError)
    return localizedOrFallback(error.message, fallback);
  // fetch() rejects with a plain TypeError ("Failed to fetch" / "NetworkError
  // when attempting to fetch resource" / "Load failed" depending on the
  // browser) when there's no network at all — the exact "офлайн жмёт
  // «Сохранить»" case this exists to surface.
  if (error instanceof TypeError) {
    return "Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.";
  }
  // Any other JS Error is a programming/runtime error, not user-facing
  // copy — its .message is essentially always English and irrelevant to
  // the user, so always fall back rather than risk showing it.
  if (error instanceof Error) return fallback;
  return fallback;
}
