// Итог карточки — сам документ результата (владелец 05.11.2026): роль сдаёт
// файл в свою ветку, а в карточку раньше попадал только отчёт о работе.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "deliverables-"));
vi.stubEnv("TASKFLOW_TEST_PROJECT_DIR", repo);

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { buildTaskOutcome, outcomeMarkdown } from "../src/lib/taskOutcome.js";
import { importTaskDeliverables } from "../src/lib/taskDeliverables.js";
import { roleReportTitle, saveRoleResultReport } from "../src/lib/roleResultReport.js";

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const commit = (file: string, text: string, message = "правка") => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
};
const report = (materials: string) => `## Результат\n\nГотово.\n\n## Что сделано\n\nНаписано.\n\n## Проверки\n\nПрочитано.\n\n## Ограничения\n\nНет.\n\n## Материалы\n\n${materials}\n`;
const noteText = (id: string) => (db.prepare("SELECT search_text FROM user_notes WHERE id=?").get(id) as { search_text: string }).search_text;

describe("документ результата в итоге карточки", () => {
  let ownerId: string;
  let taskId: string;
  let stepId: string;

  beforeAll(async () => {
    await buildApp();
    ownerId = crypto.randomUUID();
    db.prepare("INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)").run(ownerId, "Владелец", `${ownerId}@t`, "x");
    git("init", "-q", "-b", "main");
    commit("README.md", "корень");
    commit("docs/existing.md", "# Старый документ\n\nТекст старого документа\n");
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => {
    taskId = crypto.randomUUID();
    stepId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,?,?)").run(taskId, "Умный дом", ownerId);
    db.prepare("INSERT INTO subtasks(id,task_id,title,position) VALUES(?,?,?,0)").run(stepId, taskId, "Пошаговая инструкция");
    git("checkout", "-q", "main");
    git("checkout", "-qb", `roles/${taskId}`);
  });

  it("новый документ из ветки роли становится документом результата и идёт раньше отчёта", () => {
    commit("docs/instruction.md", "# Подключение к Apple Дом\n\nШаг первый: создайте мост\n");
    git("checkout", "-q", "main");
    const reportId = saveRoleResultReport(stepId, report("- Документ: `docs/instruction.md`"), ownerId);
    const docs = buildTaskOutcome(taskId).documents;
    expect(docs.map((d) => d.kind)).toEqual(["result", "report"]);
    expect(docs[0].title).toBe("Подключение к Apple Дом");
    expect(noteText(docs[0].id)).toContain("Шаг первый: создайте мост");
    expect(docs[1].id).toBe(reportId);
  });

  it("документ находится в ветке, даже если роль не упомянула его в отчёте", () => {
    commit("deliverables/plan.md", "# План\n\nТекст плана\n");
    git("checkout", "-q", "main");
    saveRoleResultReport(stepId, report("Коммит abc."), ownerId);
    expect(buildTaskOutcome(taskId).documents.filter((d) => d.kind === "result").map((d) => d.title)).toEqual(["План"]);
  });

  it("отчёт назван отчётом о проделанной работе такой-то роли", () => {
    expect(roleReportTitle("builder", "Сборка")).toBe("Отчёт о проделанной работе — Разработчик: Сборка");
    expect(roleReportTitle(null, "Сборка")).toBe("Отчёт о проделанной работе: Сборка");
    expect(roleReportTitle("builder", JSON.stringify({ key: "work_1", title: "Прокси" }))).toBe("Отчёт о проделанной работе — Разработчик: Прокси");
    const id = saveRoleResultReport(stepId, report("Нет файлов."), ownerId);
    const title = (db.prepare("SELECT title FROM user_notes WHERE id=?").get(id) as { title: string }).title;
    expect(title).toBe("Отчёт о проделанной работе: Пошаговая инструкция");
    expect(buildTaskOutcome(taskId).documents.find((d) => d.id === id)?.kind).toBe("report");
  });

  it("обычный документ роли через doc_write тоже считается результатом", () => {
    const noteId = crypto.randomUUID();
    db.prepare("INSERT INTO user_notes(id,title,content) VALUES(?,?,?)").run(noteId, "Решение", "{}");
    db.prepare("INSERT INTO task_events(id,task_id,kind,field) VALUES(?,?,'doc_written',?)").run(crypto.randomUUID(), taskId, noteId);
    expect(buildTaskOutcome(taskId).documents[0]).toMatchObject({ id: noteId, kind: "result" });
  });

  it("повторный импорт не плодит заметок, а новая версия файла обновляет ту же заметку", () => {
    commit("docs/guide.md", "# Гид\n\nВерсия один\n");
    expect(importTaskDeliverables(taskId, ownerId)).toHaveLength(1);
    expect(importTaskDeliverables(taskId, ownerId)).toHaveLength(0);
    const before = buildTaskOutcome(taskId).documents;
    expect(before).toHaveLength(1);
    commit("docs/guide.md", "# Гид\n\nВерсия два\n");
    importTaskDeliverables(taskId, ownerId);
    const after = buildTaskOutcome(taskId).documents;
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(noteText(after[0].id)).toContain("Версия два");
  });

  it("служебные файлы, код и правки чужих документов результатом не считаются", () => {
    commit("graft/concepts.md", "# Граф\n");
    commit("server/test/fixture.md", "# Фикстура\n");
    commit("server/src/a.ts", "export {};\n");
    commit("CLAUDE.md", "# Правила\n");
    commit("docs/JOURNAL.md", "# Журнал\n");
    commit("docs/existing.md", "# Старый документ\n\nЧужая правка\n");
    expect(importTaskDeliverables(taskId, ownerId)).toEqual([]);
  });

  it("ветка уже влита или удалена: документ берётся из main по ссылке в Материалах отчёта", () => {
    git("checkout", "-q", "main");
    git("branch", "-qD", `roles/${taskId}`);
    saveRoleResultReport(stepId, report("- Разбор: `docs/existing.md`\n- Чужой: `../secret.md`"), ownerId);
    const results = buildTaskOutcome(taskId).documents.filter((d) => d.kind === "result");
    expect(results.map((d) => d.title)).toEqual(["Старый документ"]);
  });

  it("общий документ, уже перенесённый другой карточкой, по ссылке не становится результатом этой", () => {
    git("checkout", "-q", "main");
    git("branch", "-qD", `roles/${taskId}`);
    saveRoleResultReport(stepId, report("- Разбор: `docs/existing.md`"), ownerId);
    expect(buildTaskOutcome(taskId).documents.filter((d) => d.kind === "result")).toEqual([]);
  });

  it("сбой git не мешает сдать шаг", () => {
    vi.stubEnv("TASKFLOW_TEST_PROJECT_DIR", path.join(repo, "нет-такой-папки"));
    try {
      expect(saveRoleResultReport(stepId, report("- `docs/none.md`"), ownerId)).toBeTruthy();
    } finally {
      vi.stubEnv("TASKFLOW_TEST_PROJECT_DIR", repo);
    }
  });

  it("в заметке итога документ результата отделён от отчётов", () => {
    const markdown = outcomeMarkdown("Умный дом", {
      verdict: null, nodes: [], branch: null,
      documents: [
        { id: "a", title: "Инструкция", updated_at: null, is_outcome: false, kind: "result" },
        { id: "b", title: "Отчёт о проделанной работе — Разработчик: Шаг", updated_at: null, is_outcome: false, kind: "report" },
      ],
    });
    expect(markdown).toMatch(/## Документы результата\n\n- Инструкция/);
    expect(markdown).toMatch(/## Отчёты о проделанной работе\n\n- Отчёт о проделанной работе — Разработчик: Шаг/);
  });
});
