import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathDeniedError, isInside, resolveCwd, resolveWithin } from "../src/pathSafety.js";

describe("проверка пути (D6)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-roots-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("путь внутри корня принимается и приводится к абсолютному", () => {
    const inside = path.join(root, "Проекты", "TaskFlowNativeBuild");
    fs.mkdirSync(inside, { recursive: true });
    expect(resolveWithin([root], inside)).toBe(inside);
    expect(resolveWithin([root], path.join(inside, "..", "TaskFlowNativeBuild"))).toBe(inside);
  });

  it("путь вне корня отклоняется явной ошибкой", () => {
    expect(() => resolveWithin([root], "/etc/passwd")).toThrow(PathDeniedError);
    expect(() => resolveWithin([root], "/etc/passwd")).toThrow(/вне разрешённых корней/);
  });

  it("корень не подставляется по префиксу строки", () => {
    // /tmp/taskflow-…-abc не проходит для корня /tmp/taskflow-…-abc (без
    // префиксного сравнения строк такой путь считался бы внутренним).
    expect(isInside(root, root + "-сосед")).toBe(false);
    expect(() => resolveWithin([root], root + "-сосед/файл")).toThrow(PathDeniedError);
  });

  it("симлинк внутри корня, уводящий наружу, отклоняется", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-outside-"));
    try {
      const link = path.join(root, "наружу");
      fs.symlinkSync(outside, link);
      expect(() => resolveWithin([root], link)).toThrow(PathDeniedError);
      expect(() => resolveWithin([root], link)).toThrow(/симлинк/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ещё не созданный путь проверяется по ближайшему существующему предку", () => {
    const future = path.join(root, "новый", "папка", "файл.swift");
    expect(resolveWithin([root], future)).toBe(future);
  });

  it("корень, которого ещё нет, не считается выходом за границу", () => {
    // База worktree может появиться только при первом вызове: предок искомого
    // пути тогда лежит выше корня, и отказывать на этом основании нельзя.
    const futureRoot = path.join(root, "worktrees", "ещё", "нет");
    expect(resolveWithin([futureRoot], path.join(futureRoot, "3e27dafe"))).toBe(path.join(futureRoot, "3e27dafe"));
  });

  it("ссылка на корень filesystem всё равно считается выходом за границу", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-root-"));
    try {
      // Проверка не должна пропускать путь, реально уводящий в корень диска.
      const link = path.join(root, "в-корень");
      fs.symlinkSync(path.parse(outside).root, link);
      expect(() => resolveWithin([root], path.join(link, "etc", "passwd"))).toThrow(PathDeniedError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("симлинк внутри корня, ведущий в другой каталог того же корня, разрешён", () => {
    const target = path.join(root, "Проекты", "TaskFlowNativeBuild");
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(root, "шорткат");
    fs.symlinkSync(target, link);
    expect(resolveWithin([root], link)).toBe(link);
  });

  it("пустой путь и не-строка — ошибка, а не молчание", () => {
    expect(() => resolveWithin([root], "")).toThrow(PathDeniedError);
    expect(() => resolveWithin([root], 42 as unknown as string)).toThrow(PathDeniedError);
  });

  it("несколько корней: подходит любой из них", () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-second-"));
    try {
      expect(resolveWithin([root, second], path.join(second, "файл"))).toBe(path.join(second, "файл"));
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("cwd операции без указания берётся из первого корня", () => {
    expect(resolveCwd([root])).toBe(root);
    expect(() => resolveCwd([root], "/etc")).toThrow(PathDeniedError);
  });

  it("~ разворачивается в домашнюю папку", () => {
    expect(resolveWithin([os.homedir()], "~/Проекты")).toBe(path.join(os.homedir(), "Проекты"));
  });
});