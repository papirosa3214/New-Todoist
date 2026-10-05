// Тестовая обёртка вокруг lib/roleCommitCheck.ts.
//
// Зачем: production-функции `commitGuardError(taskId)` и
// `inspectRoleBranch(taskId)` берут `live` по умолчанию из
// `liveServerRepo()` — это `process.cwd()/..`, корень репозитория
// сервера. В тесте мы НЕ хотим трогать боевой репо: на нём уже есть
// ветки `roles/*` от других карточек, и ahead=0 там врёт.
//
// Обёртка держит подменный `liveRepo` в module-scope переменной, и
// передаёт его явно в функции. Если `setLiveRepo(null)` —
// `commitGuardError` снова пойдёт в production (по умолчанию).
import {
  commitGuardError as realGuard,
  inspectRoleBranch as realInspect,
} from "../../src/lib/roleCommitCheck.js";

let override: string | null = null;

export const roleCommitCheck = {
  setLiveRepo(value: string | null): void {
    override = value;
  },
};

export function inspectRoleBranch(taskId: string, base: string = "main", live?: string) {
  return realInspect(taskId, base, live ?? override ?? undefined);
}

export function commitGuardError(taskId: string, live?: string) {
  return realGuard(taskId, live ?? override ?? undefined);
}
