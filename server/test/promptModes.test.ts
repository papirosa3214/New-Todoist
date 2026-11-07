import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderPromptAddendum, promptAddendumSourceFile } from "../src/runtime/roleHome.js";

// Владелец 23.10.2026: «разграничить чат и задачи на уровне инструкции и
// сервера: задача — инструкция в рамках задачи, чат — в рамках чата».
// Общая часть одна, вид работы добавляет свой канон.

const read = (file: string) => readFileSync(path.join(process.cwd(), "scripts", file), "utf8");
const fakeHome = { dir: "/roles/builder", agents: "/roles/builder/AGENTS.md", skills: "/roles/builder/skills", scripts: "/roles/builder/scripts", workspace: "/roles/builder/workspace" } as any;

describe("канон по виду работы", () => {
  it("общий канон не содержит правил чата и контракта карточки", () => {
    const common = read("role-system-prompt.md");
    expect(common).not.toContain("## Работа прямо в чате");
    expect(common).not.toContain("schema_version");
    expect(common).not.toContain("## Сдача шага");
    expect(common).toContain("## Кто ты");
  });

  it("чатовый канон: цикл чата и тот же контракт ответа", () => {
    const chat = read("role-chat-prompt.md");
    expect(chat).toContain("Цикл работы в чате");
    expect(chat).toContain("БЫСТРО:");
    expect(chat).toContain("role-answer-contract.md");
    expect(chat).not.toContain("taskflow_subtask_done(");
  });

  it("канон карточки: сдача шага, контракт приходит отдельным файлом", () => {
    const task = read("role-task-prompt.md");
    const contract = read("role-answer-contract.md");
    expect(contract).toContain("schema_version");
    expect(contract).not.toContain("## Сдача шага");
    expect(task).toContain("role-answer-contract.md");
    expect(task).toContain("## Сдача шага");
    expect(task).toContain("/api/subtasks/<шаг>/work-plan");
    expect(task).toContain("report_markdown");
    expect(task).toContain("taskflow_subtask_done");
    expect(task).not.toContain("Цикл работы в чате");
  });

  it("сервер подаёт свой канон в каждый вид хода и подставляет плейсхолдеры", () => {
    expect(promptAddendumSourceFile("chat")).toContain("role-chat-prompt.md");
    expect(promptAddendumSourceFile("task")).toContain("role-task-prompt.md");
    const chat = renderPromptAddendum("chat", "builder", fakeHome);
    const task = renderPromptAddendum("task", "builder", fakeHome);
    expect(chat).toContain("Цикл работы в чате");
    expect(chat).toContain("schema_version");
    expect(task).toContain("schema_version");
    expect(task).not.toContain("Цикл работы в чате");
    expect(task).not.toContain("{{BLOCKS}}");
    expect(task).not.toContain("{{IDENTITY}}");
  });
});
