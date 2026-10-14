import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Проверка путей (D6). Хост выполняет команды только внутри разрешённых корней,
 * и путь вне них — явная ошибка, а не тихий отказ: иначе роль не поймёт, почему
 * операция не выполнилась, и будет повторять её в другом виде.
 */
export class PathDeniedError extends Error {
  readonly code = "path_denied";
  constructor(message: string) {
    super(message);
    this.name = "PathDeniedError";
  }
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Сравнение через path.relative, а не через префикс строки: иначе корень
 * /Users/max протащил бы внутрь /Users/maximal и любую соседнюю папку.
 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Ближайший существующий предок — чтобы проверить симлинк и для ещё не созданного пути. */
function nearestExisting(target: string): string {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Приводит путь к абсолютному и проверяет, что он внутри одного из корней.
 * Симлинки проверяются по реальному пути: ссылка внутри корня, уводящая наружу,
 * — такой же выход за границу, как и прямой путь в /etc.
 */
export function resolveWithin(roots: string[], input: string, options: { label?: string } = {}): string {
  const label = options.label ? `${options.label}: ` : "";
  if (typeof input !== "string" || input.trim() === "") throw new PathDeniedError(`${label}путь не задан`);
  const resolved = path.resolve(expandHome(input.trim()));
  const root = roots.map((r) => path.resolve(r)).find((candidate) => isInside(candidate, resolved));
  if (!root) throw new PathDeniedError(`${label}«${input}» вне разрешённых корней (${roots.join(", ")})`);

  // Проверяем только тот предок, который ещё лежит внутри корня. Предок выше
  // корня означает, что сам корень ещё не создан: symlink-и разрешать нечего, и
  // mkdir создаст его прямо там, где заказано. Предок внутри корня — вот он
  // может оказаться ссылкой наружу.
  const probe = nearestExisting(resolved);
  if (isInside(root, probe)) {
    const realRoot = realpathOrSelf(root);
    const realProbe = realpathOrSelf(probe);
    if (!isInside(realRoot, realProbe)) {
      throw new PathDeniedError(`${label}«${input}» уходит за пределы корня через симлинк (${realProbe})`);
    }
  }
  return resolved;
}

/**
 * Рабочий каталог для bash/git. Не задан — берём первый корень: роль почти
 * всегда зовёт команду из папки проекта, а не из домашней папки.
 */
export function resolveCwd(roots: string[], input?: string): string {
  if (input === undefined || String(input).trim() === "") {
    const first = roots[0];
    if (!first) throw new PathDeniedError("не задан ни один разрешённый корень");
    return path.resolve(first);
  }
  return resolveWithin(roots, String(input), { label: "cwd" });
}

export function describeRoots(roots: string[]): string {
  return roots.map((root) => realpathOrSelf(path.resolve(root))).join(", ");
}