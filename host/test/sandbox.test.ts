import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { естьПесочница, подготовитьПрофиль, собратьПрофиль } from "../src/sandbox.js";

/**
 * Правка 10: песочница bash. Тест проверяет две вещи — сам текст профиля
 * и то, что он действительно держит. Второе важнее: профиль, который
 * выглядит правильно, но ничего не запрещает, хуже отсутствия песочницы,
 * потому что даёт ложное чувство защищённости.
 *
 * Тест macOS-специфичен и на Linux/.110 пропускается, а не падает: там
 * `sandbox-exec` нет по устройству платформы, и это не регрессия.
 */
const НА_MAC = process.platform === "darwin";
const описать = НА_MAC ? describe : describe.skip;

describe("профиль песочницы", () => {
  it("требует явную версию: macOS 27 не понимает (version-string)", () => {
    const профиль = собратьПрофиль(["/tmp"]);
    expect(профиль).toContain("(version 1)");
    // Строка, на которой macOS 27 спотыкается, в профиле быть не должна.
    expect(профиль).not.toContain("(version-string)");
  });

  it("запрет на домашний каталог идёт после (allow default), иначе его снимает", () => {
    const строки = собратьПрофиль(["/tmp"]).trim().split("\n");
    const allowDefault = строки.findIndex((с) => с === "(allow default)");
    const denyHome = строки.findIndex((с) => с.includes('(deny file-read* (subpath'));
    expect(allowDefault).toBeGreaterThanOrEqual(0);
    expect(denyHome).toBeGreaterThan(allowDefault);
  });

  it("закрывает системные каталоги, но возвращает их на чтение", () => {
    const профиль = собратьПрофиль(["/tmp"]);
    expect(профиль).toContain('(deny file-read* (subpath "/usr"))');
    expect(профиль).toContain('(allow file-read* (subpath "/usr"))');
    // Запрет обязан быть раньше возврата, иначе возврата просто нет.
    expect(профиль.indexOf('(deny file-read* (subpath "/usr"))')).toBeLessThan(
      профиль.indexOf('(allow file-read* (subpath "/usr"))'),
    );
  });

  it("открывает корни на чтение и запись", () => {
    const корень = "/Users/max/Проекты";
    const профиль = собратьПрофиль([корень]);
    expect(профиль).toContain(`(allow file-read* file-write* (subpath "${корень}"))`);
  });

  it("экранирует кавычки в путях, иначе профиль не соберётся", () => {
    const странный = '/Users/max/папка"с кавычкой';
    const профиль = собратьПрофиль([странный]);
    expect(профиль).toContain('папка\\"с кавычкой');
  });
});

describe("запись профиля", () => {
  it("пишет файл с правами 0600 и возвращает путь", () => {
    const профиль = подготовитьПрофиль(["/tmp"]);
    expect(профиль.путь).not.toBeNull();
    expect(профиль.ошибка).toBeNull();
    expect(fs.existsSync(профиль.путь!)).toBe(true);
    expect(fs.readFileSync(профиль.путь!, "utf-8")).toBe(профиль.текст);
    // Профиль читает любой процесс на машине — 0600 обязателен.
    expect(fs.statSync(профиль.путь!).mode & 0o777).toBe(0o600);
  });

  it("не падает на несуществующем корне", () => {
    expect(() => собратьПрофиль(["/нет/такого/пути"])).not.toThrow();
  });
});

описать("песочница держит", () => {
  const корень = fs.mkdtempSync(path.join(os.tmpdir(), "песочница-тест-"));
  // Секрет кладём в домашний каталог, а не во временный: /tmp и $TMPDIR
  // песочница открывает нарочно (без них не работают git и Xcode), и
  // «секрет в tmp» проверял бы не песочницу, а её отсутствие.
  const вне = fs.mkdtempSync(path.join(os.homedir(), ".песочница-тест-"));
  fs.writeFileSync(path.join(вне, "секрет"), "НЕ_ОТДАВАТЬ", "utf-8");

  const профиль = подготовитьПрофиль([корень]);

  function выполнить(команда: string): string {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    try {
      return execFileSync("/usr/bin/sandbox-exec", ["-f", профиль.путь!, "/bin/bash", "-c", команда], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // Отказ песочницы приходит как ненулевой код — это ожидаемый исход
      // для проверок «доступа быть не должно».
      const e = error as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  }

  it("в разрешённом корне читать и писать можно", () => {
    fs.writeFileSync(path.join(корень, "файл"), "данные", "utf-8");
    expect(выполнить(`cat ${JSON.stringify(path.join(корень, "файл"))}`)).toContain("данные");
    expect(выполнить(`touch ${JSON.stringify(path.join(корень, "новый"))}`)).toBe("");
  });

  it("вне корня читать нельзя — именно то, что проверяет правка 10", () => {
    try {
      const вывод = выполнить(`cat ${JSON.stringify(path.join(вне, "секрет"))}`);
      expect(вывод).not.toContain("НЕ_ОТДАВАТЬ");
      expect(вывод).toMatch(/Operation not permitted|deny/);
    } finally {
      fs.rmSync(вне, { recursive: true, force: true });
    }
  });

  it("домашний каталог закрыт целиком", () => {
    expect(выполнить("ls ~/.ssh 2>&1 || true")).not.toContain("id_rsa");
    expect(выполнить("ls ~ 2>&1 || true")).not.toMatch(/Documents|Library/);
    // Сравниваем по существу, а не по точному выводу: execFile добавляет
    // перевод строки, и проверка на "отказ" без него ловила бы не дыру,
    // а разницу в формате.
    const проба = выполнить("cat ~/.zshrc >/dev/null 2>&1 && echo ПРОЧИТАЛ || echo отказ");
    expect(проба).toContain("отказ");
    expect(проба).not.toContain("ПРОЧИТАЛ");
  });

  it("системное доступно, иначе не работает ни git, ни Xcode", () => {
    expect(выполнить("head -1 /etc/hosts")).toContain("#");
    expect(выполнить("which git || which /usr/bin/git")).not.toBe("");
  });
});