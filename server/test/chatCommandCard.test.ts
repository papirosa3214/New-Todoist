// Карточка команды чата: русское название, значок, подпись в два слова.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { skillCard, toolCard } from "../src/runtime/chatCommandCard.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-card-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(name: string, frontmatter: string): string {
  const file = path.join(root, name, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n# Тело\n`);
  return file;
}

describe("skillCard", () => {
  it("title, summary and icon from the skill file", () => {
    const file = skill("merge-to-main", 'name: merge-to-main\ntitle: Влить в main\nsummary: "коммит и слияние"\nicon: arrow.triangle.merge\ndescription: >-\n  Длинное описание.');
    expect(skillCard(file, "merge-to-main", "Длинное описание.")).toEqual({
      title: "Влить в main",
      summary: "коммит и слияние",
      icon: "arrow.triangle.merge",
    });
  });

  it("without card fields: name in words and the first phrase of the description", () => {
    const file = skill("daily-digest", "name: daily-digest\ndescription: Ежедневная сводка владельцу: что на сегодня. Применяй, когда просят.");
    expect(skillCard(file, "daily-digest", "Ежедневная сводка владельцу: что на сегодня. Применяй, когда просят.")).toEqual({
      title: "daily digest",
      summary: "Ежедневная сводка владельцу",
      icon: "sparkles",
    });
  });
});

describe("toolCard", () => {
  it("native tools have their own icon; tracker tools use step titles", () => {
    expect(toolCard("bash", "Команда в терминале", "Выполнить команду в рабочей папке роли")).toEqual({
      title: "Команда в терминале",
      summary: "Выполнить команду в рабочей папке роли",
      icon: "terminal",
    });
    const card = toolCard("taskflow_comment", "taskflow_comment", "Добавить комментарий к задаче. Поля: …");
    expect(card.icon).toBe("wrench.and.screwdriver");
    expect(card.summary).toBe("Добавить комментарий к задаче");
    expect(card.title).not.toContain("taskflow");
  });
});
