// Покрытие помощников онлайн-сессии: парсинг @упоминаний, выбор роли,
// чтение/запись chat_sessions. Без подъёма приложения — прицельно на
// чистую логику.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  acquireChatRoleLock,
  clearChatSession,
  getChatSession,
  getChatSessionId,
  isChatRoleLocked,
  listChatSessionsByChat,
  makeChatRunId,
  releaseChatRoleLock,
  upsertChatSession,
  _resetChatRoleLocksForTests,
} from "../src/runtime/chatSession.js";
import { _resetChatRolePickerForTests, pickRoleForChat } from "../src/routes/chats.js";

// === Замоканный embeddingClient ===
//
// «Авто» в chatRolePicker использует эмбеддинги; в тестах нам нужен
// детерминированный вход. Подменяем getEmbeddings, чтобы он возвращал
// нужный вектор; role_embeddings в БД подготовим вручную.

interface EmbeddingMockState {
  next: number[];
}

const embMock = vi.hoisted<EmbeddingMockState>(() => ({ next: [] }));

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({
    embeddings: embMock.next,
    dim: embMock.next.length,
    durationMs: 0,
  })),
}));

const uid = () => crypto.randomUUID();

let app: FastifyInstance | undefined;

function seedRoleAccounts(): void {
  const roles = [
    "researcher", "analyst", "critic_verifier",
    "architect", "builder", "qa", "designer",
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, role, role_key, type, email, password_hash, is_system_bot)
     VALUES (?, ?, 'agent', ?, 'ai', ?, '!test', 1)`,
  );
  for (const r of roles) insert.run(`role_${r}`, r, r, `${r}@test`);
}

/** Создать владельца и базовые чаты — нужно для FK chat_sessions →
 *  chats. Вызывается в beforeEach, чтобы каждый CRUD-тест жил в чистом
 *  выделенном чате. */
function seedChats(): void {
  // Владелец: role+name+type нужны, чтобы пройти CHECK users.type.
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, password_hash, role, type)
     VALUES ('owner-test', 'Test Owner', 'owner@test', '!t', 'owner', 'human')`,
  ).run();
  // Несколько чатов под разные тесты.
  const chats = [
    ["chat-x", "x"],
    ["chat-y", "y"],
    ["chat-list", "list"],
    ["chat-other", "other"],
    ["chat-lock", "lock"],
    ["chat-full", "full"],
  ];
  const insertChat = db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, ?, 'group', 'owner-test')",
  );
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)",
  );
  for (const [id, title] of chats) {
    insertChat.run(id, title);
    insertMember.run(id, "owner-test");
  }
}

function seedRoleEmbedding(role: string, vec: number[]): void {
  // Хранилище — BLOB Float32. Пакуем ровно как semanticEnrich.
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  db.prepare(
    "INSERT OR REPLACE INTO role_embeddings (role, embedding, tags, updated_at) " +
      "VALUES (?, ?, NULL, datetime('now'))",
  ).run(role, buf);
}

beforeAll(async () => {
  // Схема и миграции нужны и для чистых юнит-тестов: buildApp() гоняет
  // migrate() и runMigrations(), а мы в этом файле хотим работать
  // только с db.ts напрямую. Подъём buildApp() один раз — дёшево.
  app = await buildApp();
  seedRoleAccounts();
});

beforeEach(() => {
  _resetChatRoleLocksForTests();
  _resetChatRolePickerForTests();
  embMock.next = [];
  db.prepare("DELETE FROM chat_sessions").run();
  db.prepare("DELETE FROM chats").run();
  db.prepare("DELETE FROM role_embeddings").run();
  seedChats();
});

afterAll(async () => {
  db.prepare("DELETE FROM chat_sessions").run();
  db.prepare("DELETE FROM chats").run();
  db.prepare("DELETE FROM role_embeddings").run();
  if (app) await app.close();
});

describe("chatSession helpers (CRUD по chat_sessions)", () => {
  it("getChatSessionId возвращает null для новой пары", () => {
    expect(getChatSessionId("chat-x", "role_qa")).toBeNull();
  });

  it("upsertChatSession создаёт и апсёртит по составному ключу", () => {
    upsertChatSession("chat-x", "role_qa", "sess-1");
    expect(getChatSessionId("chat-x", "role_qa")).toBe("sess-1");
    // Повторный upsert с тем же ключом и новым sessionId — заменяет.
    upsertChatSession("chat-x", "role_qa", "sess-2");
    expect(getChatSessionId("chat-x", "role_qa")).toBe("sess-2");
    // Другая роль — независимая запись.
    upsertChatSession("chat-x", "role_architect", "sess-A");
    expect(getChatSessionId("chat-x", "role_architect")).toBe("sess-A");
    expect(getChatSessionId("chat-x", "role_qa")).toBe("sess-2");
  });

  it("clearChatSession снимает запись", () => {
    upsertChatSession("chat-y", "role_qa", "sess-y");
    expect(getChatSessionId("chat-y", "role_qa")).toBe("sess-y");
    clearChatSession("chat-y", "role_qa");
    expect(getChatSessionId("chat-y", "role_qa")).toBeNull();
  });

  it("listChatSessionsByChat отдаёт строки по chat_id", () => {
    upsertChatSession("chat-list", "role_qa", "sess-q");
    upsertChatSession("chat-list", "role_architect", "sess-a");
    upsertChatSession("chat-other", "role_qa", "sess-other");
    const rows = listChatSessionsByChat("chat-list");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role_id).sort()).toEqual([
      "role_architect",
      "role_qa",
    ]);
  });

  it("acquire/release лок — взаимоисключающие, повторный release безопасен", () => {
    expect(isChatRoleLocked("chat-lock", "role_qa")).toBe(false);
    expect(acquireChatRoleLock("chat-lock", "role_qa")).toBe(true);
    expect(isChatRoleLocked("chat-lock", "role_qa")).toBe(true);
    expect(acquireChatRoleLock("chat-lock", "role_qa")).toBe(false);
    releaseChatRoleLock("chat-lock", "role_qa");
    expect(isChatRoleLocked("chat-lock", "role_qa")).toBe(false);
    // Повторный release — no-op, без падения.
    releaseChatRoleLock("chat-lock", "role_qa");
  });

  it("makeChatRunId возвращает уникальные id с префиксом chat_", () => {
    const a = makeChatRunId();
    const b = makeChatRunId();
    expect(a).toMatch(/^chat_/);
    expect(b).toMatch(/^chat_/);
    expect(a).not.toBe(b);
  });

  it("getChatSession возвращает полную строку", () => {
    upsertChatSession("chat-full", "role_architect", "sess-XYZ");
    const row = getChatSession("chat-full", "role_architect");
    expect(row?.pi_session_id).toBe("sess-XYZ");
    expect(row?.role_id).toBe("role_architect");
    expect(row?.chat_id).toBe("chat-full");
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe("pickRoleForChat (адресация в чате)", () => {
  it("@роль в тексте — приоритет над семантикой", async () => {
    // Даже если семантика говорит «analyst», explicit @qa должна
    // победить (потому что в чате только qa — на остальных не
    // проголосовать).
    embMock.next = [1, 0];
    seedRoleEmbedding("qa", [1, 0]);
    seedRoleEmbedding("architect", [0, 1]);

    const role = await pickRoleForChat({
      messageText: "@qa проверь баг",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBe("qa");
  });

  // Телефон вставляет имя участника так, как его видит человек (22.09.2026).
  it("@Имя роли по-русски — адресует ту же роль", async () => {
    embMock.next = [1, 0];
    seedRoleEmbedding("qa", [1, 0]);
    seedRoleEmbedding("architect", [0, 1]);
    for (const [id, name] of [
      ["role_qa", "QA"],
      ["role_architect", "Архитектор"],
    ]) {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
    }

    const role = await pickRoleForChat({
      messageText: "@Архитектор подскажи схему",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBe("architect");
  });

  // R1 (обновление): @роль вне участников — НЕ подменяется дефолтом.
  // Если пользователь явно попросил роль, которой нет в чате, мы не
  // обманываем — возвращаем null. В прямом чате с одной ролью особенно
  // важно: @designer не должен превращаться в «qa, потому что больше
  // некого».
  it("@роль не из участников чата → null (R1: не подменяем дефолтом)", async () => {
    embMock.next = [1, 0];
    seedRoleEmbedding("qa", [1, 0]);

    const role = await pickRoleForChat({
      messageText: "@designer рисуй макет",
      memberRoles: ["qa"],
    });
    expect(role).toBeNull();
  });

  it("семантика выбирает роль с ближайшим вектором", async () => {
    // Запросный вектор (1, 0). qa — (1, 0) → cosine 1; architect — (0, 1) → 0.
    embMock.next = [1, 0];
    seedRoleEmbedding("qa", [1, 0]);
    seedRoleEmbedding("architect", [0, 1]);

    const role = await pickRoleForChat({
      messageText: "проверь пожалуйста",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBe("qa");
  });

  it("семантика при равенстве отдаёт ту роль, что в memberRoles первой", async () => {
    embMock.next = [1, 0];
    seedRoleEmbedding("qa", [1, 0]);
    seedRoleEmbedding("architect", [1, 0]); // такой же вектор

    const role = await pickRoleForChat({
      messageText: "одинаково обоим",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBe("qa");
  });

  it("если в чате одна роль — она и выбирается без эмбеддингов", async () => {
    embMock.next = []; // даже если embedding client вернёт пусто
    const role = await pickRoleForChat({
      messageText: "просто сообщение",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa");
  });

  it("нет member-ролей — null, без сетевых вызовов", async () => {
    const role = await pickRoleForChat({
      messageText: "@qa сделай",
      memberRoles: [],
    });
    expect(role).toBeNull();
  });

  it("только @роль в тексте без memberRoles — null", async () => {
    const role = await pickRoleForChat({
      messageText: "@qa сделай",
      memberRoles: [],
    });
    expect(role).toBeNull();
  });

  it("пустой текст + несколько ролей — null (нечего сравнивать)", async () => {
    embMock.next = [];
    seedRoleEmbedding("qa", [1, 0]);
    seedRoleEmbedding("architect", [0, 1]);

    const role = await pickRoleForChat({
      messageText: "   ",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBeNull();
  });

  it("неизвестная роль в @mention — null (не считаем ложным хитом)", async () => {
    // @designer_id — синтаксис похож на @роль, но «designer_id» вне
    // VALID_ROLES. Проверяем, что такое упоминание НЕ становится
    // результатом; раз в чате только qa — будет qa.
    embMock.next = [];
    const role = await pickRoleForChat({
      messageText: "@designer_id или @qa",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa");
  });

  // B4 (замечание Гермеса 21.09.2026): parseRoleMention должен ловить
  // @роль только по границе слова. Иначе e-mail «support@acme» или URL
  // «/admin@host» ложно адресуют сообщение роли @acme/@host. Здесь
  // собираем все типичные ложные срабатывания и проверяем, что они
  // обрабатываются по общему правилу.
  it("B4: e-mail в тексте не считается @упоминанием", async () => {
    // Только одна роль в чате — короткий путь без эмбеддингов. Но
    // именно этот случай показал проблему: @acme не должен был
    // перехватывать письмо на support@acme.
    const role = await pickRoleForChat({
      messageText: "напиши на support@acme.com пожалуйста",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa");
  });

  it("B4: @ перед буквой внутри слова не считается @упоминанием", async () => {
    embMock.next = [];
    // «напиши в тг @username_про» — подчёркивание после @ делает это
    // НЕ ролью (имена ролей только из VALID_ROLES), но и проверка
    // границы тоже отбивает: «тг @username» — перед @ идёт пробел,
    // значит это валидный mention-токен. Здесь интересен обратный кейс:
    // буква прямо перед @.
    const role = await pickRoleForChat({
      messageText: "проверь user@host",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa"); // не «host», а единственная роль в чате
  });

  it("B4: начало строки @роль — валидное упоминание", async () => {
    const role = await pickRoleForChat({
      messageText: "@qa проверь",
      memberRoles: ["qa", "architect"],
    });
    expect(role).toBe("qa");
  });

  it("B4: после знаков препинания @роль — валидное упоминание", async () => {
    const role = await pickRoleForChat({
      messageText: "привет! @qa как дела?",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa");
  });

  // R1 (замечание Гермеса 21.09.2026): в direct-чате с одной ролью
  // @упоминание тоже должно побеждать над дефолтом. Раньше короткий
  // путь memberRoles.length === 1 отдавал первую роль без проверки
  // mention вообще — то есть @роль был не нужен. Это тихая подмена
  // намерения пользователя.
  it("R1: direct-чат с одной ролью — explicit @роль всё равно побеждает", async () => {
    // Только qa в чате, но пользователь явно просит architect — он не
    // участник чата, поэтому null (mention не в memberRoles).
    // Проверим вариант, где @роль совпадает с единственной ролью в чате:
    embMock.next = [];
    const role = await pickRoleForChat({
      messageText: "@qa привет",
      memberRoles: ["qa"],
    });
    expect(role).toBe("qa");
  });

  it("R1: direct-чат с одной ролью и @роль не из участников — null", async () => {
    // @architect есть в тексте, но architect не участник direct-чата.
    // Раньше код бы отдал «единственную роль в чате» (qa) и проигнорировал
    // бы @упоминание. Теперь @упоминание проверяется ПЕРВЫМ, и если оно
    // валидно, но не из memberRoles, мы возвращаем null — НЕ подменяем.
    // Семантика memberRoles.length < 2 идёт ВТОРОЙ.
    const role = await pickRoleForChat({
      messageText: "@architect подскажи",
      memberRoles: ["qa"],
    });
    expect(role).toBeNull();
  });
});
