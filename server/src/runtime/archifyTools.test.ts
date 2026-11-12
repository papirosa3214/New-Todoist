import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { ARCHIFY_PREFIX, archifyToolName, diagramTargetDir } from "./archifyTools.js";
import { isOnDemandOperation } from "./roleToolCatalog.js";

// Archify — схемы по коду (владелец 09.11.2026): роли архитектора, оркестратора,
// помощника и разработчика рисуют диаграммы тем же движком, что агенты на маке.
// Схемы не висят в каждом запросе: только через загрузчик по требованию.
describe("archify в роутере ролей", () => {
  it("имя операции — префикс плюс имя команды CLI", () => {
    expect(ARCHIFY_PREFIX).toBe("archify_");
    expect(archifyToolName("render")).toBe("archify_render");
    expect(archifyToolName("validate")).toBe("archify_validate");
  });

  it("все операции Archify грузятся по требованию, а не в каждом запросе", () => {
    for (const command of ["guide", "validate", "render", "check"]) {
      expect(isOnDemandOperation(archifyToolName(command))).toBe(true);
    }
  });

  it("диаграмма по проекту ложится в папку артефактов этого проекта", () => {
    const project = path.join(os.homedir(), "Проекты", "TaskFlowNativeBuild");
    expect(diagramTargetDir(project)).toBe(path.join(project, "docs", "artifacts", "diagrams"));
  });

  it("общая диаграмма ложится в серверную папку артефактов", () => {
    expect(diagramTargetDir()).toBe(path.join(os.homedir(), "artifacts", "diagrams"));
  });
});
