import { describe, expect, it } from "vitest";
import { appendSkillsNote, russianTitle, skillLabel, skillLabels, skillsLine } from "../src/lib/skillCatalog.js";
import { normalizeSavedSteps } from "../src/lib/chatMessages.js";

describe("русские заголовки навыков", () => {
  it("берёт первый заголовок # из тела", () => {
    const md = "---\nname: x\n---\n\n# Диагностика багов\n\n**Железное правило**";
    expect(russianTitle(md, "x")).toBe("Диагностика багов");
  });

  it("без заголовка отдаёт запасное имя", () => {
    expect(russianTitle("---\nname: x\n---\n\nтекст", "x")).toBe("x");
  });

  it("файла нет — имя папки, без падения", () => {
    expect(skillLabel("diagnosing-bugs", "/nope/SKILL.md")).toEqual({
      name: "diagnosing-bugs",
      title: "diagnosing-bugs",
    });
  });

  it("без повторов и в порядке подключения", () => {
    const got = skillLabels([
      { name: "a", filePath: null },
      { name: "b", filePath: null },
      { name: "a", filePath: null },
    ]);
    expect(got.map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("навыки в сохранённых шагах хода", () => {
  it("проходят нормализацию до клиента", () => {
    const steps = normalizeSavedSteps({
      duration_ms: 10,
      items: [],
      skills: [{ name: "diagnosing-bugs", title: "Диагностика багов" }],
    });
    expect(steps?.skills).toEqual([{ name: "diagnosing-bugs", title: "Диагностика багов" }]);
  });

  it("мусор в skills не ломает разбор", () => {
    const steps = normalizeSavedSteps({
      duration_ms: 0,
      items: [],
      skills: [{ name: "ok", title: 42 }, { title: "без имени" }, null],
    });
    expect(steps?.skills).toEqual([{ name: "ok", title: "42" }]);
  });

  it("хода без навыков — поля нет", () => {
    const steps = normalizeSavedSteps({ duration_ms: 0, items: [] });
    expect(steps && "skills" in steps).toBe(false);
  });
});

describe("строка навыков в ответе", () => {
  const skills = [
    { name: "diagnosing-bugs", title: "Диагностика багов" },
    { name: "ponytail-review", title: "Ревью правки" },
    { name: "diagnosing-bugs", title: "Диагностика багов" },
  ];

  it("русские заголовки, без повторов, без латинских имён", () => {
    expect(skillsLine(skills)).toBe("_навыки: Диагностика багов · Ревью правки_");
  });

  it("дописывается в обычный текст", () => {
    const out = appendSkillsNote("Готово.", skills, false);
    expect(out).toBe("Готово.\n\n_навыки: Диагностика багов · Ревью правки_");
  });

  it("в разметку v1 добавляется блоком text", () => {
    const envelope = JSON.stringify({ ok: true, blocks: [{ type: "text", text: "Готово." }] });
    const parsed = JSON.parse(appendSkillsNote(envelope, skills, true));
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1]).toEqual({ type: "text", text: "_навыки: Диагностика багов · Ревью правки_" });
  });

  it("битый JSON не портится", () => {
    expect(appendSkillsNote("{не json", skills, true)).toBe("{не json");
  });

  it("пустой список — ответ не меняется", () => {
    expect(appendSkillsNote("Готово.", [], false)).toBe("Готово.");
  });
});
