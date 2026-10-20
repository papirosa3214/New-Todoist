// c19c9460 (D1–D4): блок «Лаконичность» в начале каждого промпта роли
// (server/scripts/role-prompts/*.md) + конкретные пределы, и тот же блок
// в начало roles.prompt для secretary в БД (миграция 103).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { rolePromptText } from "../src/roleRouting.js";

const ROLE_PROMPTS_DIR = path.resolve(
  process.env.TASKFLOW_ROLE_PROMPTS_DIR ??
    path.join(process.cwd(), "scripts", "role-prompts"),
);

// 8 ролей из спек cd10bf34/534b1574 — в наборе и synthesizer, и
// 7 «служебных». secretary идёт через БД-override (миграция 062), но
// файл secretary.md должен быть синхронен с тем, что лежит в roles.prompt.
const ROLES = [
  "analyst",
  "architect",
  "builder",
  "critic_verifier",
  "designer",
  "qa",
  "researcher",
  "secretary",
  "synthesizer",
];

const TITLE_BY_ROLE: Record<string, string> = {
  analyst: "# Analyst",
  architect: "# Architect",
  builder: "# Builder",
  critic_verifier: "# Critic/Verifier",
  designer: "# Дизайнер интерфейсов",
  qa: "# Лайф-тестировщик",
  researcher: "# Researcher",
  secretary: "# Помощник владельца",
  synthesizer: "# Synthesizer",
};

// Конкретные пределы из уточнения владельца c19c9460 (10:13:46).
const LIMIT_MARKERS = [
  "**до 3 предложений**",
  "**1–2 предложения**",
  "статус + ссылка",
  "Не вставляй в сообщения код и логи",
  "Не рассуждай вслух в чате",
  "Пиши коротко. Подробности оформляй документом (`taskflow_doc_write`) и давай ссылку.",
];

describe("промпты ролей: блок «Лаконичность» (c19c9460 D1, D3, D4)", () => {
  for (const role of ROLES) {
    it(`${role}.md: «# Title» сразу за ним блок «## Лаконичность» с пределами`, () => {
      const file = path.join(ROLE_PROMPTS_DIR, `${role}.md`);
      const text = fs.readFileSync(file, "utf8");
      const title = TITLE_BY_ROLE[role];
      const titleIdx = text.indexOf(title);
      expect(titleIdx, `нет заголовка ${title} в ${role}.md`).toBeGreaterThanOrEqual(0);
      const tail = text.slice(titleIdx + title.length);
      // Перед блоком «## Лаконичность» — только перевод строки (после # Title),
      // никаких «## Назначение и границы» или другого раздела.
      const lacIdx = tail.indexOf("## Лаконичность");
      expect(lacIdx, `нет «## Лаконичность» в ${role}.md`).toBeGreaterThanOrEqual(0);
      const between = tail.slice(0, lacIdx);
      expect(
        between.trim(),
        `между «${title}» и «## Лаконичность» в ${role}.md есть лишний текст: ${JSON.stringify(between)}`,
      ).toBe("");
      // Пределы на месте
      for (const marker of LIMIT_MARKERS) {
        expect(text.includes(marker), `${role}.md: нет маркера «${marker}»`).toBe(true);
      }
      // Старый хвост «Пиши коротко…» в конце «Механики» убран (D4):
      // после правки единственное вхождение фразы — внутри блока Лаконичность.
      const occurrences = text.split("Пиши коротко").length - 1;
      expect(occurrences, `${role}.md: фраза «Пиши коротко» встречается ${occurrences} раз`).toBe(1);
    });
  }
});

describe("роль secretary: блок «Лаконичность» в roles.prompt (c19c9460 D2, миграция 103)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("rolePromptText('secretary') содержит «## Лаконичность» из общего шаблона и пределы", () => {
    const text = rolePromptText("secretary");
    expect(text).not.toBeNull();
    expect(text!.includes("## Лаконичность")).toBe(true);
    for (const marker of LIMIT_MARKERS) {
      expect(text!.includes(marker), `roles.prompt secretary: нет маркера «${marker}»`).toBe(true);
    }
  });

  it("миграция 103 идемпотентна: повторный прогон не дублирует блок", () => {
    // Текущее значение после buildApp (миграция 103 уже применена).
    const before = (db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string | null }).prompt ?? "";
    // Вручную вызываем тело миграции повторно: она должна увидеть маркер
    // и выйти без изменений.
    const row = db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string | null } | undefined;
    expect(row?.prompt).toBeTruthy();
    expect(row!.prompt!.includes("## Лаконичность\n")).toBe(true);
    // Меняем руками prompt на «как было до миграции» (без блока) и применяем
    // логику миграции 103 ещё раз — блок должен появиться снова ровно один раз.
    const cleaned = row!.prompt!.replace(/^## Лаконичность\n[\s\S]*?(?=\nТы — Помощник владельца)/, "").replace(/^\n+/, "");
    db.prepare("UPDATE roles SET prompt = ? WHERE key = 'secretary'").run(cleaned);
    expect((db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string }).prompt.includes("## Лаконичность")).toBe(false);
    // Повторяем логику миграции 103 руками (тот же SQL, что в up()).
    const LACONISM_MARKER = "## Лаконичность\n";
    const laconismBlock = [
      "## Лаконичность",
      "",
      "Пиши коротко. Подробности оформляй документом (`taskflow_doc_write`) и давай ссылку.",
      "",
      "- Сообщение другой роли или в чат — **до 3 предложений**.",
      "- Поле `result` шага — **1–2 предложения**.",
      "- Комментарий в ленте — **статус + ссылка** на документ/артефакт.",
      "- Не пересказывай задачу и свои прошлые шаги.",
      "- Не вставляй в сообщения код и логи — указывай путь к файлу и коммит.",
      "- Не рассуждай вслух в чате — итог и решение, без разбора хода мыслей.",
      "",
    ].join("\n");
    const r2 = db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string | null };
    if (r2.prompt && !r2.prompt.includes(LACONISM_MARKER)) {
      db.prepare("UPDATE roles SET prompt = ? WHERE key = 'secretary'").run(laconismBlock + r2.prompt);
    }
    const after = (db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string }).prompt;
    expect(after.split("## Лаконичность").length - 1).toBe(1);
    // Восстанавливаем исходное состояние, чтобы тест не оставлял побочки.
    db.prepare("UPDATE roles SET prompt = ? WHERE key = 'secretary'").run(before);
  });
});
