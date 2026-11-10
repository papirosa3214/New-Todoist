import { describe, expect, it } from "vitest";
import { russianTitle, skillLabel, skillLabels } from "../src/lib/skillCatalog.js";
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
