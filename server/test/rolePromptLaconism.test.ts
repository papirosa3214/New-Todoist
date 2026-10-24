// Блок «Лаконичность» в инструкции роли (c19c9460 D1–D4).
//
// Источник правды изменился (20.10.2026): промпты ролей из
// `server/scripts/role-prompts/*.md` убраны в Корзину — инструкции ролей
// теперь в общем каноне `server/scripts/role-system-prompt.md` плюс личный
// `AGENTS.md` роли (см. runtime/roleHome.ts, roleInstructionText).
//
// Тест прежде стоял на файлах `scripts/role-prompts/*.md` и после их удаления
// падал с ENOENT на каждой из восьми ролей (24.10.2026, аудит качества
// тестов). Теперь проверяется то, что реально уходит в модель: собранная
// инструкция роли — общий канон + личный AGENTS.md.
//
// Проверка не «файл существует», а содержание: блок «## Лаконичность» есть
// в собранной инструкции, за ним идут конкретные пределы, и фраза
// «Пиши коротко» встречается ровно один раз.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { rolePromptText } from "../src/roleRouting.js";

// Роли, у которых есть личная папка и своя инструкция. secretary идёт
// отдельно: его инструкция живёт в БД (миграция 103) плюс общий канон.
const ROLES = [
  "analyst",
  "architect",
  "builder",
  "critic_verifier",
  "designer",
  "qa",
  "researcher",
];

// Конкретные пределы из уточнения владельца c19c9460 (10:13:46).
const LIMIT_MARKERS = [
  "**до 3 предложений**",
  "**1–2 предложения**",
  "статус + ссылка",
  "Не вставляй в сообщения код и логи",
  "Не рассуждай вслух в чате",
  "Пиши коротко. Подробности оформляй документом (`taskflow_doc_write`) и давай ссылку.",
];

describe("инструкции ролей: блок «Лаконичность» (c19c9460)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const role of ROLES) {
    it(`${role}: в собранной инструкции есть «## Лаконичность» с пределами`, () => {
      const text = rolePromptText(role);
      expect(text, `${role}: инструкция роли недоступна`).toBeTruthy();
      const lacIdx = text!.indexOf("## Лаконичность");
      expect(lacIdx, `${role}: нет «## Лаконичность» в инструкции`).toBeGreaterThanOrEqual(0);
      for (const marker of LIMIT_MARKERS) {
        expect(text!.includes(marker), `${role}: нет маркера «${marker}»`).toBe(true);
      }
      // Старый хвост «Пиши коротко…» убран (D4): единственное вхождение
      // фразы — внутри блока Лаконичность, а не в конце «Механики».
      const occurrences = text!.split("Пиши коротко").length - 1;
      expect(occurrences, `${role}: фраза «Пиши коротко» встречается ${occurrences} раз`).toBe(1);
    });
  }

  it("общий канон — единственный источник блока, а не восемь копий", () => {
    // Блок лежит в scripts/role-system-prompt.md; личные AGENTS.md ролей
    // своей копии не содержат — иначе правка канона разъезжалась бы с
    // ролями (именно это и было проблемой до 20.10.2026).
    const ролиСкопией: string[] = [];
    for (const role of ROLES) {
      const text = rolePromptText(role) ?? "";
      // Считаем, сколько раз блок встречается в СОБРАННОЙ инструкции:
      // канон + AGENTS.md роли. Блок должен быть ровно один.
      const сколько = text.split("## Лаконичность").length - 1;
      if (сколько !== 1) ролиСкопией.push(`${role}:${сколько}`);
    }
    expect(ролиСкопией.join(", ")).toBe("");
  });
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
    // Меняем руками prompt на «как было до миграции» (без блока) и применяем
    // логику миграции 103 ещё раз — блок должен появиться снова ровно один раз.
    const row = db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string | null } | undefined;
    expect(row?.prompt).toBeTruthy();
    expect(row!.prompt!.includes("## Лаконичность\n")).toBe(true);
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
