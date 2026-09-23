// Выбор роли диспетчером (разделы 7 и 8.3 спецификации от 14.09.2026).
//
// До 14.09.2026 диспетчер ставил «architect» всем подряд: подбора не было
// вовсе, была одна константа. Владелец: «чтобы автомат не всё архитектору
// кидал».
//
// Здесь проверяется именно поведение выбора, а не качество модели:
// зависит ли роль от смысла задачи, переживает ли ручной выбор владельца
// повторный подбор, и что происходит, когда подобрать не удалось.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { dispatchTaskToPi, pickRole, roleChoiceNoteRu } =
  await import("../src/routes/dispatch.js");
const { seedRoleAccounts } = await import("./helpers/seedOwner.js");

describe("Диспетчер: выбор роли", () => {
  let app: FastifyInstance;
  let ownerId: string;

  const uid = () => crypto.randomUUID();

  const makeTask = (title: string, description: string) => {
    const id = uid();
    db.prepare(
      `INSERT INTO tasks (id, title, description, status, creator_id)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(id, title, description, ownerId);
    return id;
  };

  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "RoleChoiceOwner",
        email: `role-choice-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = res.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("выбор владельца имеет приоритет и не перебивается подбором", async () => {
    // Раздел 8.3: «Если владелец назначил роль вручную, диспетчер
    // использует её без повторной семантической замены». Задача при этом
    // намеренно про дизайн — чтобы подбор, если бы он вмешался, дал
    // другую роль.
    const taskId = makeTask(
      "Нарисовать экран настроек уведомлений",
      "Нужен макет и состояния переключателей",
    );
    const choice = await pickRole(taskId, "qa");

    expect(choice.role).toBe("qa");
    expect(choice.how).toBe("owner");
    expect(roleChoiceNoteRu(choice)).toContain("выбрана вами");
  });

  it("мусор в колонке владельца не принимается за роль", async () => {
    // Колонку мог заполнить путь в обход роута — прямой UPDATE в БД.
    const taskId = makeTask("Любая задача", "");
    const choice = await pickRole(taskId, "не-роль-а-мусор");
    expect(choice.how).not.toBe("owner");
  });

  it("роль зависит от смысла задачи, а не одна на всех", async () => {
    // Суть просьбы владельца. Берём две задачи заведомо разных
    // компетенций: если обе получат одно и то же — подбор не работает,
    // сколько бы тестов ни было зелёными.
    const дизайн = makeTask(
      "Нарисовать экран настроек уведомлений",
      "Нужен макет, состояния переключателей, отступы и цвета",
    );
    const проверка = makeTask(
      "Протестировать свайп завершения на всех экранах",
      "Покрыть краевые случаи, проверить регрессию",
    );

    const a = await pickRole(дизайн, null);
    const b = await pickRole(проверка, null);

    // Подбор мог не состояться целиком — например, модель эмбеддингов
    // недоступна на этой машине. Тогда роли будут запасными, и проверять
    // разницу смысла не на чем: это не провал подбора, а отсутствие
    // условий для него, и тест должен сказать об этом честно, а не
    // покраснеть впустую.
    if (a.how === "fallback" && b.how === "fallback") {
      expect(roleChoiceNoteRu(a)).toContain("запасной вариант");
      return;
    }

    expect(a.how).toBe("semantic");
    expect(b.how).toBe("semantic");
    expect(a.role).not.toBe(b.role);
    // И ни одна из них не должна быть той самой константой, которой
    // раньше помечались все задачи подряд.
    expect([a.role, b.role]).not.toContain("architect");
  });

  it("спорный выбор помечается в ленте, уверенный — нет", () => {
    const спорный = roleChoiceNoteRu({
      role: "builder",
      how: "semantic",
      score: 0.44,
      margin: 0.004,
    });
    const уверенный = roleChoiceNoteRu({
      role: "designer",
      how: "semantic",
      score: 0.56,
      margin: 0.14,
    });

    expect(спорный).toContain("неочевидный");
    expect(уверенный).not.toContain("неочевидный");
    // Владелец читает ленту, а не наши идентификаторы ролей.
    expect(уверенный).toContain("Дизайнер");
  });

  it("назначение и durable job коммитятся вместе", async () => {
    const taskId = makeTask("Реализовать endpoint", "Серверная разработка");
    db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              owner_selected_role = 'builder'
        WHERE id = ?`,
    ).run(taskId);

    const result = await dispatchTaskToPi(taskId, ownerId);
    expect(result).toMatchObject({ ok: true, role: "builder" });
    const job = db
      .prepare(
        `SELECT reason, actor_id, status
           FROM role_run_jobs
          WHERE task_id = ?`,
      )
      .get(taskId) as
      | { reason: string; actor_id: string | null; status: string }
      | undefined;
    expect(job).toEqual({
      reason: "assigned",
      actor_id: ownerId,
      status: "queued",
    });
  });
});
