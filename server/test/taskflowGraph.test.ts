import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const generator = path.join(projectRoot, "scripts/generate-taskflow-status-graph.mjs");

describe("статусный граф TaskFlow", () => {
  it("строит HTML из снимка задач и показывает все карточки", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-graph-"));
    const input = path.join(dir, "tasks.json");
    const output = path.join(dir, "status.html");
    fs.writeFileSync(
      input,
      JSON.stringify({
        generatedAt: "2026-09-19T17:30:00+03:00",
        tasks: [
          { id: "a1b2c3d4-0000-0000-0000-000000000001", title: "Проверить <схему>", status: "active", agentState: "review" },
          { id: "b1c2d3e4-0000-0000-0000-000000000002", title: "iOS-подзадачи", status: "active", agentState: null },
        ],
      }),
    );

    const run = spawnSync(process.execPath, [generator, "--input", input, "--output", output], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);

    const html = fs.readFileSync(output, "utf8");
    expect(html).toContain("Статус TaskFlow");
    expect(html).toContain("a1b2c3d4");
    expect(html).toContain("b1c2d3e4");
    expect(html).toContain("Проверить &lt;схему&gt;");
    expect(html).toContain("На проверке");
    expect(html).toContain("Не взята");
  });

  it("маршрут задачи не содержит снимок устаревшей очереди", () => {
    const routeMap = fs.readFileSync(
      path.join(projectRoot, "docs/current/taskflow-task-route-map.html"),
      "utf8",
    );
    expect(routeMap).not.toContain("8ca87c61");
    expect(routeMap).not.toContain("d86884c4");
    expect(routeMap).toContain("taskflow-status-graph.html");
  });
});
