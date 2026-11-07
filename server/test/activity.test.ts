// Канал живой активности агента: формулировки и защита от утечек.
//
// Проверяем ровно то, что видит владелец в карточке, и то, что уходит в
// промпт модели на телефоне. Обе вещи ломались на живых данных: строка
// приходила сырым перечнем вызовов, а в diff могли попасть ключи.
import { describe, it, expect } from "vitest";
import {
  buildText,
  describeAction,
  maskSecrets,
} from "../src/routes/activity.js";

const at = 1_000_000;
const act = (over: Partial<any> = {}) => ({
  kind: "read" as const,
  target: "src/lib/search.ts",
  actor: "Claude_Bot",
  at,
  ...over,
});

describe("формулировка действия", () => {
  it("к пути добавляет глагол, а не показывает его голым", () => {
    // Владелец 25.08.2026 про голые пути в раскрытом списке: «нахуя мне вот
    // эта сырая хуета». Формулировка живёт здесь, одна на всех потребителей.
    expect(describeAction(act())).toBe("разбирается в src/lib/search.ts");
    expect(describeAction(act({ kind: "edit" }))).toBe(
      "правит src/lib/search.ts",
    );
    expect(describeAction(act({ kind: "search", target: "searchNotes" }))).toBe(
      "ищет searchNotes",
    );
  });

  it("команду показывает целиком после глагола", () => {
    expect(
      describeAction(act({ kind: "run", target: "npm", detail: "npm test" })),
    ).toBe("проверяет: npm test");
    expect(
      describeAction(act({ kind: "run", target: "git", detail: "git log" })),
    ).toBe("сверяет историю: git log");
  });

  it("тесты и документацию называет по существу", () => {
    expect(describeAction(act({ target: "src/lib/search.test.ts" }))).toBe(
      "проверяет поведение src/lib/search.test.ts",
    );
    expect(describeAction(act({ target: "AGENT-PROTOCOL.md" }))).toBe(
      "сверяется с документацией AGENT-PROTOCOL.md",
    );
  });
});

describe("строка в карточке", () => {
  const task = (running?: string) => ({
    subtasks: running
      ? [{ title: running, state: "running" }, { title: "Другой", state: "pending" }]
      : [{ title: "Другой", state: "pending" }],
  });

  it("ставит впереди название идущего шага", () => {
    expect(buildText(task("Вернуть хвосты"), [act()])).toBe(
      "Вернуть хвосты · разбирается в src/lib/search.ts",
    );
  });

  it("без идущего шага показывает одно действие", () => {
    // Шаг не в работе — приписывать действие к чужому шагу нельзя.
    expect(buildText(task(), [act()])).toBe("разбирается в src/lib/search.ts");
  });

  it("схлопывает пачку файлов одной папки", () => {
    const actions = [
      act({ target: "src/api/a.ts" }),
      act({ target: "src/api/b.ts", at: at + 100 }),
      act({ target: "src/api/c.ts", at: at + 200 }),
    ];
    expect(buildText(task(), actions)).toBe("разбирается в 3 файла в src/api");
  });

  it("не считает перечитывание одного файла тремя файлами", () => {
    const actions = [
      act({ target: "src/api/a.ts" }),
      act({ target: "src/api/a.ts", at: at + 100 }),
      act({ target: "src/api/a.ts", at: at + 200 }),
    ];
    expect(buildText(task(), actions)).toBe("разбирается в src/api/a.ts");
  });
});

describe("маскирование секретов", () => {
  // Строка уходит и в браузер, и в промпт модели на телефоне — чистим на
  // входе, а не при показе: один забытый путь показа сливает ключ.
  it("прячет длинные шестнадцатеричные ключи", () => {
    expect(maskSecrets("curl -H 'Bearer 55caaf1f5f89704349e5fdefa885910d68e7a3c8'")).not.toContain(
      "55caaf1f",
    );
  });

  it("прячет токены с узнаваемым префиксом", () => {
    expect(maskSecrets("TASKFLOW=tf_b7ab893b7c3db823c0baff51")).toBe(
      "TASKFLOW=***",
    );
    expect(maskSecrets("key sk-abcdefgh12345678")).toBe("key ***");
  });

  it("прячет значение после --token и --password", () => {
    expect(maskSecrets("psql --password hunter2")).toBe("psql --password ***");
    expect(maskSecrets("cli --token=abcdef123456")).toBe("cli --token=***");
  });

  it("обычный код не трогает", () => {
    const code = "export function searchNotes(q: string) { return q.trim(); }";
    expect(maskSecrets(code)).toBe(code);
  });
});
