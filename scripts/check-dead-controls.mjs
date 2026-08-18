#!/usr/bin/env node
/**
 * Проверка на «мёртвые» интерактивные элементы во фронте.
 *
 * Ловит:
 *   1. <button> без onClick и без type="submit" — мёртвая кнопка.
 *   2. Обработчик-пустышка: onClick={() => {}} или тело, которое ничего
 *      не делает по существу (только console.*, только return).
 *   3. Переход в никуда: navigate("/…") или to="/…" на маршрут,
 *      которого нет среди <Route path="…"> в src/App.tsx
 *      (с пониманием параметров вида /task/:id).
 *
 * Отдельно, не как ошибку, выводит кнопки с disabled — это заглушки,
 * ожидающие решения, а не мёртвые элементы.
 *
 * Ложные срабатывания:
 *   - Кнопка, куда обработчик приходит через `{...props}` — не мёртвая,
 *     пропускается молча (это сквозной проброс, не тупик).
 *   - Явное исключение комментарием `// dead-controls-ignore: причина`
 *     (или в JSX-комментарии `{/* dead-controls-ignore: причина *\/}`)
 *     рядом со строкой — но только с причиной. Маркер без причины
 *     исключением не считается и findings всё равно попадает в отчёт.
 *
 * Запуск: node scripts/check-dead-controls.mjs [srcDir] [appTsxPath]
 * По умолчанию проверяется src/ текущего репозитория.
 * Код возврата: 1, если есть настоящие находки (не заглушки, не игнор).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ROOT = path.resolve(process.argv[2] || path.join(REPO_ROOT, "src"));
const APP_TSX = path.resolve(process.argv[3] || path.join(ROOT, "App.tsx"));

const TAGS = ["button", "Link", "NavLink"];

// ───────────────────────── файловый обход ─────────────────────────

function walkTsx(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsx(full));
    } else if (entry.isFile() && full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ───────────────────── посимвольный разбор JSX ─────────────────────
// Регексом открывающий тег не взять надёжно: внутри могут быть вложенные
// {}, строки, шаблонные литералы. Идём по символам, считаем глубину {}
// и уважаем кавычки/бэктики.

/** text[start] указывает на '<'. Возвращает {end, tag} — конец тега
 * (индекс символа '>') и его текст, либо null, если тег не закрылся. */
function openTagSpan(text, start) {
  let depthBrace = 0;
  let quote = null;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depthBrace++;
    } else if (c === "}") {
      depthBrace--;
    } else if (c === ">" && depthBrace === 0) {
      return { end: i, tag: text.slice(start, i + 1) };
    }
    i++;
  }
  return null;
}

/** text[start] === '{'. Возвращает содержимое (включая внешние {}),
 * уважая вложенность и кавычки. */
function extractBalancedBraces(text, start) {
  let depth = 0;
  let quote = null;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

/** Значение строкового литерала (в кавычках или бэктиках), начиная с
 * text[start] — символ кавычки. Возвращает {content, end}. */
function extractStringLiteral(text, start) {
  const q = text[start];
  let i = start + 1;
  let raw = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      raw += c + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === q) return { content: raw, end: i };
    raw += c;
    i++;
  }
  return null;
}

/** Гасит содержимое строковых литералов (внутри кавычек/бэктиков), заменяя
 * его пробелами, но сохраняя длину строки и сами кавычки-разделители. Так
 * атрибут по имени ищется только вне значений других атрибутов — иначе
 * "disabled" внутри className="... disabled:opacity-50 ..." или "to"
 * внутри произвольного текста дали бы ложное срабатывание/промах. */
function maskStrings(tag) {
  const chars = tag.split("");
  let quote = null;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (quote) {
      if (c === "\\") {
        chars[i] = " ";
        if (i + 1 < chars.length) chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
      } else {
        chars[i] = " ";
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    i++;
  }
  return chars.join("");
}

/** Ищет атрибут `name=` внутри уже вырезанного текста тега.
 * Учитывает, что это должен быть именно атрибут (после имени идёт
 * '=', а перед именем — пробел/начало тега), а не подстрока внутри
 * значения другого атрибута (например "disabled:opacity-50"). Поиск
 * идёт по тексту с замаскированными строками (см. maskStrings), чтобы
 * совпадение внутри чужого строкового значения не считалось. */
function attrRegex(name) {
  return new RegExp(`(^|[\\s{])${name}(=|(?=[\\s/>]))`);
}

function hasAttr(tag, name) {
  return attrRegex(name).test(maskStrings(tag));
}

function getAttrValue(tag, name) {
  const re = new RegExp(`(^|[\\s{])${name}=`);
  const m = re.exec(maskStrings(tag));
  if (!m) return null;
  const i = m.index + m[0].length;
  const c = tag[i];
  if (c === "{") {
    const raw = extractBalancedBraces(tag, i);
    return raw === null ? null : { kind: "expr", raw };
  }
  if (c === '"' || c === "'" || c === "`") {
    const lit = extractStringLiteral(tag, i);
    return lit === null ? null : { kind: "string", raw: lit.content };
  }
  return null;
}

// ───────────────────── проверка «пустого» обработчика ─────────────────────

const TRIVIAL_STMT =
  /^(console\.(log|warn|error|info|debug)\(.*\)|return(\s+undefined)?|void\s+0)$/;

/** braceContent — то, что вернул getAttrValue для onClick (kind === "expr"),
 * т.е. текст вида "{() => {...}}". Возвращает true, если функция ничего
 * не делает по существу. */
function isTrivialHandler(braceContent) {
  let inner = braceContent.slice(1, -1).trim();

  let body = null;
  const arrow = inner.match(/^(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/);
  if (arrow) {
    body = arrow[2].trim();
  } else {
    const fn = inner.match(/^(async\s+)?function\b[^{]*\{([\s\S]*)\}\s*$/);
    if (fn) body = `{${fn[2]}}`;
  }
  if (body === null) return false; // не инлайн-функция — не проверяем

  if (body.startsWith("{") && body.endsWith("}")) {
    const stmts = body
      .slice(1, -1)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (stmts.length === 0) return true;
    return stmts.every((s) => TRIVIAL_STMT.test(s));
  }
  if (body === "") return true;
  return TRIVIAL_STMT.test(body);
}

// ───────────────────── исключение комментарием ─────────────────────

const IGNORE_RE = /dead-controls-ignore:\s*([^\n*]*)/;

/** Ищет маркер-исключение в окне строк вокруг тега (2 строки до, 2 после).
 * Возвращает: null — маркера нет; "" — маркер есть, но без причины;
 * непустая строка — причина. */
function findIgnoreMarker(lines, startLine, endLine) {
  const from = Math.max(0, startLine - 1 - 2);
  const to = Math.min(lines.length, endLine + 2);
  const windowText = lines.slice(from, to).join("\n");
  const m = IGNORE_RE.exec(windowText);
  if (!m) return null;
  return m[1].replace(/-->\s*$/, "").trim();
}

const SPREAD_RE = /\{\s*\.\.\.[A-Za-z_$]/;

// ───────────────────── маршруты из App.tsx ─────────────────────

function loadRoutes(appTsxPath) {
  if (!existsSync(appTsxPath)) return null;
  const text = readFileSync(appTsxPath, "utf-8");
  const routes = [];
  const re = /<Route\b[^>]*?\bpath=(["'])(.*?)\1/g;
  let m;
  while ((m = re.exec(text))) {
    routes.push(m[2]);
  }
  return routes;
}

function normalizeTarget(raw) {
  // убираем query/hash, схлопываем шаблонные подстановки ${...} в маркер PARAM
  let p = raw.replace(/\$\{[^}]*\}/g, "PARAM");
  const cut = p.search(/[?#]/);
  if (cut !== -1) p = p.slice(0, cut);
  return p;
}

function isExternal(raw) {
  return /^(https?:|mailto:|tel:|#)/.test(raw.trim());
}

function routeExists(rawTarget, routes) {
  const target = normalizeTarget(rawTarget);
  if (!target.startsWith("/")) return true; // относительный/непонятный — не проверяем
  const tSegs = target.split("/");
  for (const r of routes) {
    if (r === "*") continue; // catch-all — не считается настоящим адресом назначения
    const rSegs = r.split("/");
    if (rSegs.length !== tSegs.length) continue;
    let ok = true;
    for (let i = 0; i < rSegs.length; i++) {
      const rs = rSegs[i];
      const ts = tSegs[i];
      if (ts === "PARAM") continue; // динамическая подстановка ${...} — совпадает с любым сегментом маршрута
      if (rs.startsWith(":")) {
        if (!(ts && ts.length > 0)) {
          ok = false;
          break;
        }
        continue;
      }
      if (rs !== ts) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// ───────────────────── основной проход ─────────────────────

const errors = []; // {file, line, why, detail}
const stubs = []; // disabled-заглушки
const ignored = []; // подавлено с причиной

function lineOf(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

function checkFile(filePath, routes) {
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split("\n");
  const rel = path.relative(REPO_ROOT, filePath);

  const tagRe = new RegExp("<(" + TAGS.join("|") + ")(?=[\\s/>])", "g");
  let m;
  while ((m = tagRe.exec(text))) {
    const start = m.index;
    const span = openTagSpan(text, start);
    if (!span) continue;
    const { tag, end } = span;
    const name = m[1];
    const startLine = lineOf(text, start);
    const endLine = lineOf(text, end);

    const hasSpread = SPREAD_RE.test(tag);
    const flat = tag.replace(/\s+/g, " ").trim();
    const snippet = flat.length > 140 ? flat.slice(0, 140) + "…" : flat;

    const record = (why, detail) => {
      const marker = findIgnoreMarker(lines, startLine, endLine);
      if (marker !== null && marker !== "") {
        ignored.push({ file: rel, line: startLine, why, reason: marker });
        return;
      }
      if (marker === "") {
        detail +=
          " (рядом есть dead-controls-ignore, но без причины — исключение не принято)";
      }
      errors.push({ file: rel, line: startLine, why, detail, snippet });
    };

    if (name === "button") {
      const hasClick = hasAttr(tag, "onClick");
      const hasSubmit = /type=(["'])submit\1/.test(tag);
      const hasDisabled = hasAttr(tag, "disabled");

      if (!hasClick && !hasSubmit) {
        if (hasDisabled) {
          stubs.push({ file: rel, line: startLine, snippet });
          continue;
        }
        if (hasSpread) continue; // обработчик может прийти через {...props}
        record(
          "мёртвая кнопка",
          "нет onClick и это не submit-кнопка формы — нажатие ничего не делает",
        );
        continue;
      }

      if (hasClick) {
        const val = getAttrValue(tag, "onClick");
        if (val && val.kind === "expr" && isTrivialHandler(val.raw)) {
          record(
            "обработчик-пустышка",
            "onClick ничего не делает по существу (пусто / только console / только return)",
          );
        }
        // navigate("...") внутри onClick ловит общий проход по всему
        // файлу ниже (checkFile) — здесь не дублируем.
      }
      continue;
    }

    // Link / NavLink
    const toVal = getAttrValue(tag, "to");
    if (!toVal) {
      if (hasSpread) continue;
      record(
        `${name} без to`,
        "переход никуда не ведёт — атрибут to отсутствует",
      );
      continue;
    }
    if (routes) {
      const targets =
        toVal.kind === "string"
          ? [toVal.raw]
          : extractLiteralsFromExpr(toVal.raw);
      for (const t of targets) {
        if (!t || isExternal(t) || !t.startsWith("/")) continue;
        if (!routeExists(t, routes)) {
          record(
            `${name} ведёт в никуда`,
            `маршрут "${t}" отсутствует среди <Route path="…"> в src/App.tsx`,
          );
        }
      }
    }
  }

  // navigate("...") вне JSX-тегов (например, в обработчиках, вынесенных
  // в теле компонента, а не только внутри onClick={...})
  if (routes) {
    const navRe = /\bnavigate\(\s*/g;
    let nm;
    while ((nm = navRe.exec(text))) {
      const i = nm.index + nm[0].length;
      const c = text[i];
      if (c !== '"' && c !== "'" && c !== "`") continue;
      const lit = extractStringLiteral(text, i);
      if (!lit) continue;
      const target = lit.content;
      if (isExternal(target) || !target.startsWith("/")) continue;
      if (!routeExists(target, routes)) {
        const ln = lineOf(text, nm.index);
        const marker = findIgnoreMarker(lines, ln, ln);
        if (marker !== null && marker !== "") {
          ignored.push({
            file: rel,
            line: ln,
            why: "navigate в никуда",
            reason: marker,
          });
          continue;
        }
        let detail = `маршрут "${target}" отсутствует среди <Route path="…"> в src/App.tsx`;
        if (marker === "") {
          detail +=
            " (рядом есть dead-controls-ignore, но без причины — исключение не принято)";
        }
        errors.push({
          file: rel,
          line: ln,
          why: "navigate в никуда",
          detail,
          snippet: `navigate("${target}")`,
        });
      }
    }
  }
}

/** Достаёт строковые/шаблонные литералы вида "/foo" или `/foo/${x}` из
 * произвольного JS-выражения (для to={...}). */
function extractLiteralsFromExpr(expr) {
  const out = [];
  const re = /["'`]/g;
  let m;
  while ((m = re.exec(expr))) {
    const lit = extractStringLiteral(expr, m.index);
    if (lit) {
      out.push(lit.content);
      re.lastIndex = lit.end + 1;
    }
  }
  return out;
}

// ───────────────────── запуск ─────────────────────

const files = walkTsx(ROOT);
const routes = loadRoutes(APP_TSX);

for (const f of files) checkFile(f, routes);

console.log(`Проверка мёртвых элементов интерфейса`);
console.log(`Каталог: ${path.relative(REPO_ROOT, ROOT) || ROOT}`);
console.log(`Файлов .tsx: ${files.length}`);
if (!routes) {
  console.log(
    `(App.tsx не найден по пути ${APP_TSX} — переходы в никуда не проверялись)`,
  );
} else {
  console.log(`Маршрутов в App.tsx: ${routes.length}`);
}
console.log("");

if (errors.length === 0) {
  console.log("Мёртвых элементов не найдено.");
} else {
  console.log(`Найдено проблем: ${errors.length}\n`);
  for (const e of errors) {
    console.log(`${e.file}:${e.line} — ${e.why}`);
    console.log(`    ${e.detail}`);
    console.log(`    ${e.snippet}`);
  }
}

if (stubs.length > 0) {
  console.log(
    `\nЗаглушки (disabled, решение за владельцем) — ${stubs.length}:`,
  );
  for (const s of stubs) {
    console.log(`${s.file}:${s.line}`);
    console.log(`    ${s.snippet}`);
  }
}

if (ignored.length > 0) {
  console.log(
    `\nПомечено как исключение (dead-controls-ignore) — ${ignored.length}:`,
  );
  for (const i of ignored) {
    console.log(`${i.file}:${i.line} — ${i.why} — причина: ${i.reason}`);
  }
}

process.exit(errors.length > 0 ? 1 : 0);
