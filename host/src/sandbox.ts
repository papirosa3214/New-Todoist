import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Песочница bash (правка 10 плана taskflow-mac-host).
 *
 * Почему это отдельный файл, а не строчка в bash.ts: профиль длинный, его
 * придётся читать и править, и проверять он должен быть независимо от
 * запуска команды — иначе «песочница работает» нечем подтвердить.
 *
 * Что закрываем: домашний каталог целиком. Что оставляем: разрешённые корни,
 * системные каталоги без которых не работают git и Xcode, временные
 * каталоги и точечные файлы конфигурации (`.gitconfig` и подобные).
 *
 * Роль получает `bash`, который может прочитать что угодно из `$HOME`,
 * если песочницы нет: `cat ~/.ssh/id_ed25519` — это одна команда, и никакая
 * проверка путей её не остановит, потому что путь передаётся не аргументом
 * операции, а текстом команды.
 */

/** macOS 27 больше не понимает `(version-string)`; профилю нужна явная версия. */
export const SANDBOX_VERSION = 1;

/**
 * Каталоги системы, которые нужны роли для работы: интерпретаторы, git,
 * Xcode. Без них не запустится ни одна сборка, поэтому их нельзя закрывать.
 */
const СИСТЕМНЫЕ_ДЛЯ_ЧТЕНИЯ = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/etc",
  "/dev",
  "/opt/homebrew",
  "/Applications/Xcode.app",
  "/Applications/Git.app",
];

/**
 * Временные каталоги: без них не работают ни git, ни xcodebuild, ни npm.
 * Отдельная тройка из `SYSTEM` — иначе их пришлось бы открывать на запись
 * через `private`, а это обходной путь в обход правил.
 */
const ВРЕМЕННЫЕ = ["/var/folders", "/private/var/folders", "/private/tmp", "/tmp"];

/**
 * Кэши инструментов сборки в $HOME, куда нужно ПИСАТЬ. SwiftPM кладёт кэш
 * манифестов в ~/Library/Caches/org.swift.swiftpm по зашитому пути (подмена
 * HOME не помогает) — без записи «Could not resolve package dependencies».
 * Секретов там нет: только манифесты и метаданные пакетов (15.10.2026).
 */
const КЭШИ_СБОРКИ = ["~/Library/Caches/org.swift.swiftpm", "~/Library/org.swift.swiftpm"];

/**
 * Файлы конфигурации пользователя, без которых git и Xcode не стартуют.
 * Именно файлы, а не каталоги: `~/.config` целиком открывать нельзя.
 */
const КОНФИГИ = [
  "~/.gitconfig",
  "~/.gitignore_global",
  // ~/.zshrc и ~/.zprofile здесь НЕ нужны: песочница закрывает домашний
  // каталог, а открыть точечно файл — значит открыть роль содержимое
  // пользовательского окружения целиком. node/xcode/git запускаются
  // неинтерактивно и .zshrc не читают.
  "~/.nvm",
  "~/Library/Developer/Xcode",
  "~/Library/Preferences/com.apple.dt.Xcode.plist",
  "~/Library/Caches/com.apple.dt.Xcode",
  "~/.config/git",
];

function экранировать(путь: string): string {
  return путь.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function развернуть(путь: string): string {
  if (путь === "~") return os.homedir();
  if (путь.startsWith("~/")) return path.join(os.homedir(), путь.slice(2));
  return путь;
}

export interface ПрофильПесочницы {
  /** Текст профиля .sb — его же пишут в лог, когда песочница не сработала. */
  текст: string;
  /** Куда профиль записан; null, если записать не удалось. */
  путь: string | null;
  ошибка: string | null;
}

/**
 * Собрать профиль: сначала глухой запрет на домашний каталог, потом точечные
 * разрешения поверх. Порядок обязателен и неочевиден — `allow default` в
 * начале профиля снимает любой `deny`, который стоит ниже, поэтому запрет
 * на `$HOME` приходится ставить сразу после него, а все исключения — после
 * запрета.
 */
export function собратьПрофиль(roots: string[]): string {
  const строки = [
    `(version ${SANDBOX_VERSION})`,
    "(allow default)",
    // Запрет целиком на домашний каталог: ниже его точечно отменяем.
    `(deny file-read* (subpath "${экранировать(os.homedir())}"))`,
  ];
  for (const каталог of СИСТЕМНЫЕ_ДЛЯ_ЧТЕНИЯ) {
    строки.push(`(deny file-read* (subpath "${экранировать(каталог)}"))`);
  }
  for (const каталог of СИСТЕМНЫЕ_ДЛЯ_ЧТЕНИЯ) {
    строки.push(`(allow file-read* (subpath "${экранировать(каталог)}"))`);
  }
  for (const каталог of ВРЕМЕННЫЕ) {
    строки.push(`(allow file-read* file-write* (subpath "${экранировать(каталог)}"))`);
  }
  for (const корень of roots) {
    const абсолютный = path.resolve(развернуть(корень));
    строки.push(`(allow file-read* file-write* (subpath "${экранировать(абсолютный)}"))`);
    // Метаданные предков корня (stat, не листинг и не содержимое): mkdir -p и
    // git проходят путь от «/» и спотыкались о запрет на $HOME — «could not
    // create leading directories» при клонировании пакетов SwiftPM (15.10.2026).
    for (let предок = path.dirname(абсолютный); предок !== path.dirname(предок); предок = path.dirname(предок)) {
      строки.push(`(allow file-read-metadata (literal "${экранировать(предок)}"))`);
    }
  }
  for (const каталог of КЭШИ_СБОРКИ) {
    const абсолютный = path.resolve(развернуть(каталог));
    строки.push(`(allow file-read* file-write* (subpath "${экранировать(абсолютный)}"))`);
    for (let предок = path.dirname(абсолютный); предок !== path.dirname(предок); предок = path.dirname(предок)) {
      строки.push(`(allow file-read-metadata (literal "${экранировать(предок)}"))`);
    }
  }
  for (const файл of КОНФИГИ) {
    строки.push(`(allow file-read* (subpath "${экранировать(развернуть(файл))}"))`);
  }
  return `${строки.join("\n")}\n`;
}

/**
 * Записать профиль во временный файл. sandbox-exec умеет только файл, а не
 * строку, а передавать длинный профиль аргументом неудобно и он виден в
 * списке процессов всего на время запуска.
 */
export function подготовитьПрофиль(roots: string[]): ПрофильПесочницы {
  const текст = собратьПрофиль(roots);
  try {
    const каталог = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-sandbox-"));
    const файл = path.join(каталог, "profile.sb");
    fs.writeFileSync(файл, текст, { encoding: "utf-8", mode: 0o600 });
    return { текст, путь: файл, ошибка: null };
  } catch (error) {
    // Без профиля запускать нельзя: «нет песочницы» хуже, чем не запустить,
    // — иначе роль решит, что операция просто не удалась.
    return {
      текст,
      путь: null,
      ошибка: `не записался профиль песочницы: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

/**
 * Доступна ли песочница на этой машине.
 *
 * Обязательна она только там, где реально работает роль, — на macOS. На
 * Linux (это `.110`, где хост только разрабатывается и гоняются тесты)
 * `sandbox-exec` нет по устройству платформы, и требовать его там значит
 * запретить хосту работать целиком. Поэтому проверка различает «платформа
 * без песочницы» и «macOS, где песочница сломалась» — второе это ошибка.
 */
export function естьПесочница(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    fs.accessSync(SANDBOX_EXECUTABLE, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Команда запуска: sandbox-exec с профилем, если песочница есть, и сама
 * оболочка — если нет. Аргументы оболочки возвращаются в обоих случаях:
 * вариант «профиль не нужен» — это «запустить без песочницы», а вовсе не
 * «запустить с пустым списком аргументов».
 */
export function командаЗапуска(профиль: string | null, shell: string, args: string[]): { файлы: string[]; аргументы: string[] } {
  if (профиль === null) return { файлы: [shell], аргументы: args };
  return { файлы: [SANDBOX_EXECUTABLE], аргументы: ["-f", профиль, shell, ...args] };
}