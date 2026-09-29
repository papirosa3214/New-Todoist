// Владелец 30.09.2026: пять специальных инструментов Исследователя
// (web_search, web_get, ocr, youtube, local_model) были заведены в
// профиле researcher.json для СТАРОЙ схемы (внешний Pi-процесс говорит по
// MCP) и молча перестали работать 23.09.2026, когда роли переехали
// исполняться внутри сервера — внешние MCP там не подключаются вообще.
// Этот файл проверяет только границу: инструменты видны РОВНО researcher
// и никому больше. Сама работа процесса (запись в stdin, разбор JSON из
// stdout) — реальный, не смоделированный вызов python, проверена живым
// прогоном на .110 (не юнит-тестом: мокать node:child_process ради
// нескольких строк передачи данных менее убедительно, чем факт, что
// процесс правда стартует и правда отвечает).
import { describe, expect, it } from "vitest";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

const RESEARCH_TOOL_NAMES = ["web_search", "web_get", "ocr", "youtube", "local_model"];

describe("research-инструменты — видны только Исследователю", () => {
  it("researcher получает все пять, в дополнение к обычным taskflow_*", () => {
    const names = taskflowTools("researcher", null).map((t) => t.name);
    for (const tool of RESEARCH_TOOL_NAMES) expect(names).toContain(tool);
    expect(names).toContain("taskflow_task"); // обычные тоже остаются
  });

  it("ни одна другая роль их не получает", () => {
    for (const role of ["builder", "qa", "architect", "designer", "analyst", "critic_verifier"]) {
      const names = taskflowTools(role, null).map((t) => t.name);
      for (const tool of RESEARCH_TOOL_NAMES) expect(names).not.toContain(tool);
    }
  });

  it("экран «Команда» (inProcessToolNames, role='') их тоже не показывает", async () => {
    const { inProcessToolNames } = await import("../src/runtime/inProcessRun.js");
    const names = inProcessToolNames();
    for (const tool of RESEARCH_TOOL_NAMES) expect(names).not.toContain(tool);
  });
});
