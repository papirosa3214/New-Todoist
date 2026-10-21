import { beforeAll, afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  addClient,
  handleDeviceOpResult,
  liveDeviceIds,
  removeClient,
  resetDeviceOpsForTests,
  runDeviceOp,
} from "../src/ws.js";
import {
  APPLE_TOOL_NAMES,
  secretaryAppleTools,
} from "../src/runtime/secretaryAppleTools.js";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

/**
 * Серверная часть доступа Помощника владельца к Apple Напоминаниям и
 * Календарю (карточка 9aca4795, шаг «серверный мост»).
 *
 * Проверяем то, что решает сервер: канал команд устройству (запрос ушёл на
 * телефон — ответ вернулся), права роли (операции только у Помощника,
 * удаление закрыто) и честность описаний (удаление недоступно — модель
 * предупреждает, а не обещает).
 *
 * Телефон здесь настоящий только в смысле сокета: подставляется живой
 * сокет устройства, чтобы не трогать настоящий айфон (живую проверку
 * делает владелец после спаривания телефона).
 */

const DEVICE_ID = "dev-test-apple-1";
const DEVICE_ID_2 = "dev-test-apple-2";

function владелецId(): string {
  const строка = db
    .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return строка?.id ?? "u-secretary";
}

function устройство(id: string, имя: string) {
  db.prepare(
    `INSERT OR REPLACE INTO devices(id,user_id,install_id,name,model,os,app_version,token_hash,token_prefix,created_at,last_seen_at,revoked_at,revoke_reason)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
  ).run(
    id,
    владелецId(),
    `install-${id}`,
    имя,
    "iPhone18,4",
    "iOS 26.5.1",
    "1.0.0",
    crypto.randomBytes(16).toString("hex"),
    "tfd_test",
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

function фейковыйСокет() {
  const кадры: any[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      кадры.push(JSON.parse(data));
    },
    close: () => {},
  };
  return { socket, кадры };
}

const инструментПо = (имя: string) =>
  secretaryAppleTools({ role: "secretary" }).find((т) => т.name === имя)!;

const подождать = (мс: number) => new Promise((r) => setTimeout(r, мс));

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  устройство(DEVICE_ID, "iPhone Air");
  устройство(DEVICE_ID_2, "iPad");
});

afterAll(() => {
  resetDeviceOpsForTests();
  db.prepare("DELETE FROM devices WHERE id IN (?,?)").run(DEVICE_ID, DEVICE_ID_2);
});

describe("Каталог операций Apple для Помощника владельца", () => {
  it("в каталоге ровно восемь операций apple_*", () => {
    expect([...APPLE_TOOL_NAMES]).toEqual([
      "apple_reminders_create",
      "apple_reminders_list",
      "apple_reminders_complete",
      "apple_reminders_reschedule",
      "apple_reminders_delete",
      "apple_calendar_agenda",
      "apple_calendar_create",
      "apple_calendar_update",
    ]);
    const имена = secretaryAppleTools({ role: "secretary" }).map((т) => т.name);
    expect(имена).toEqual([...APPLE_TOOL_NAMES]);
  });

  it("описания на русском: первая строка — глагол, объект и время", () => {
    for (const инструмент of secretaryAppleTools({ role: "secretary" })) {
      const первая = инструмент.description.split("\n")[0];
      expect(первая.length, инструмент.name).toBeGreaterThan(10);
      expect(/[а-яё]/i.test(первая), инструмент.name).toBe(true);
      // Время в первой строке: «в указанное время», «за указанный период»,
      // «на другое время», «прямо сейчас», «на указанное время».
      expect(
        /время|период|сейчас|день|днем|дня|час|завтра|сегодня/i.test(первая),
        `${инструмент.name}: ${первая}`,
      ).toBe(true);
    }
  });

  it("синонимы «напоминалка», «встреча», «событие» есть в описаниях", () => {
    const описания = secretaryAppleTools({ role: "secretary" })
      .map((т) => т.description)
      .join("\n");
    expect(описания).toContain("напоминалка");
    expect(описания).toContain("встреча");
    expect(описания).toContain("событие");
  });

  it("описание удаления прямо говорит, что удаление недоступно", () => {
    const описание = инструментПо("apple_reminders_delete").description;
    expect(описание).toMatch(/УДАЛЕНИЕ НЕДОСТУПНО/i);
    expect(описание).toContain("apple_reminders_complete");
    expect(описание).toContain("apple_reminders_reschedule");
    expect(описание).toMatch(/руками на айфоне/i);
  });

  it("закрытие и перенос тоже предупреждают, что стирать надо руками", () => {
    for (const имя of ["apple_reminders_complete", "apple_reminders_reschedule"]) {
      const описание = инструментПо(имя).description;
      expect(описание, имя).toMatch(/УДАЛЕНИЕ НЕДОСТУПНО/i);
      expect(описание, имя).toMatch(/руками на айфоне/i);
    }
  });
});

describe("Права роли", () => {
  it("операции apple_* достаются только Помощнику владельца", () => {
    for (const имя of APPLE_TOOL_NAMES) {
      if (имя === "apple_reminders_delete") continue; // удаление закрыто отдельным правилом
      expect(roleToolAllowed("secretary", имя), имя).toBe(true);
      for (const роль of ["builder", "qa", "critic_verifier", "analyst", "designer"]) {
        expect(roleToolAllowed(роль, имя), `${роль}:${имя}`).toBe(false);
      }
    }
  });

  it("удаление недоступно даже Помощнику (delete в имени режется правилом роли)", () => {
    expect(roleToolAllowed("secretary", "apple_reminders_delete")).toBe(false);
    expect(roleToolAllowed("builder", "apple_reminders_delete")).toBe(false);
  });

  it("в наборе Помощника удаления нет, а остальные семь операций есть", () => {
    // Набор роли — с фильтром прав (taskflowTools без unscoped): именно его
    // получает роль в ходе.
    const набор = taskflowTools("secretary", null, "task", "slot");
    const имена = набор.map((т) => т.name);
    expect(имена.filter((имя) => имя.startsWith("apple_")).sort()).toEqual([
      "apple_calendar_agenda",
      "apple_calendar_create",
      "apple_calendar_update",
      "apple_reminders_complete",
      "apple_reminders_create",
      "apple_reminders_list",
      "apple_reminders_reschedule",
    ]);
  });

  it("вызов удаления через универсальный инструмент запрещён ролью", async () => {
    const каталог = buildRoleToolCatalog({
      role: "secretary",
      mode: "work",
      runId: "test-apple",
      taskId: "task",
    });
    const ответ = JSON.parse(
      (
        await каталог.customTools[0].execute("x", {
          action: "invoke",
          operation: "apple_reminders_delete",
          version: 1,
          arguments: { id: "r1" },
        })
      ).content[0].text,
    );
    expect(ответ.ok).toBe(false);
    expect(ответ.error.code).toBe("FORBIDDEN");
  });

  it("поиск по каталогу не выдаёт удаление, а остальные операции находит", async () => {
    const каталог = buildRoleToolCatalog({
      role: "secretary",
      mode: "work",
      runId: "test-apple",
      taskId: "task",
    });
    const ответ = JSON.parse(
      (
        await каталог.customTools[0].execute("x", {
          action: "discover",
          query: "напоминание",
        })
      ).content[0].text,
    );
    const операции = ответ.data.operations.map((о: any) => о.operation);
    expect(операции).toContain("apple_reminders_list");
    expect(операции).not.toContain("apple_reminders_delete");
  });

  it("у других ролей операций apple_* нет вообще", () => {
    for (const роль of ["builder", "qa", "critic_verifier"]) {
      const каталог = buildRoleToolCatalog({
        role: роль,
        mode: "work",
        runId: "test-apple",
        taskId: "task",
      });
      expect(
        каталог.operations.filter((т) => т.name.startsWith("apple_")).length,
        роль,
      ).toBe(0);
    }
  });
});

describe("Канал команд устройству", () => {
  it("команда уходит на телефон, ответ возвращается ролью", async () => {
    const { socket, кадры } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      const обещание = инструментПо("apple_reminders_create").execute("1", {
        title: "Позвонить в сервис",
        dueDate: "2026-10-22T09:00:00+03:00",
      });
      await подождать(20);
      const кадр = кадры.at(-1);
      expect(кадр.type).toBe("device_op");
      expect(кадр.v).toBe(1);
      expect(кадр.op).toBe("reminder.create");
      expect(кадр.arguments).toEqual({
        title: "Позвонить в сервис",
        dueDate: "2026-10-22T09:00:00+03:00",
      });
      expect(typeof кадр.opId).toBe("string");

      handleDeviceOpResult({
        type: "device_op_result",
        v: 1,
        opId: кадр.opId,
        ok: true,
        data: { id: "x-apple-1", title: "Позвонить в сервис" },
      });
      const ответ = await обещание;
      expect(JSON.stringify(ответ)).toContain("Позвонить в сервис");
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });

  it("список напоминаний отдаёт идентификаторы: их видно в тексте ответа", async () => {
    const { socket, кадры } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      const обещание = инструментПо("apple_reminders_list").execute("1", {
        includeCompleted: true,
      });
      await подождать(20);
      const кадр = кадры.at(-1);
      expect(кадр.op).toBe("reminder.list");
      handleDeviceOpResult({
        type: "device_op_result",
        opId: кадр.opId,
        ok: true,
        data: {
          lists: [{ id: "l1", title: "Семья" }],
          reminders: [
            {
              id: "r1",
              title: "Позвонить в сервис",
              dueDate: "2026-10-22T09:00:00+03:00",
              listId: "l1",
              isCompleted: false,
            },
          ],
        },
      });
      const ответ = JSON.stringify(await обещание);
      expect(ответ).toContain("r1");
      expect(ответ).toContain("Позвонить в сервис");
      expect(ответ).toContain("22.10.2026 09:00");
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });

  it("отказ телефона (нет доступа) доходит до роли текстом, а не молчанием", async () => {
    const { socket, кадры } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      const обещание = инструментПо("apple_reminders_create").execute("1", {
        title: "Хлеб",
      });
      await подождать(20);
      const кадр = кадры.at(-1);
      handleDeviceOpResult({
        type: "device_op_result",
        opId: кадр.opId,
        ok: false,
        error: { code: "access_denied", message: "Нет доступа к Напоминаниям" },
      });
      await expect(обещание).rejects.toThrow(/доступ/i);
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });

  it("телефон не ответил — отказ по таймауту, а не бесконечное ожидание", async () => {
    const { socket } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      await expect(
        runDeviceOp(DEVICE_ID, "reminder.list", {}, { timeoutMs: 60 }),
      ).rejects.toThrow(/не ответил/i);
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });

  it("устройства нет на связи — внятный отказ, а не пустой ответ", async () => {
    await expect(
      инструментПо("apple_reminders_list").execute("1", {}, undefined as any),
    ).rejects.toThrow(/не на связи/i);
  });

  it("несколько живых устройств — операция не угадывает, какой телефон", async () => {
    const первый = фейковыйСокет();
    const второй = фейковыйСокет();
    addClient(владелецId(), первый.socket as any, DEVICE_ID);
    addClient(владелецId(), второй.socket as any, DEVICE_ID_2);
    try {
      await expect(
        инструментПо("apple_reminders_list").execute("1", {}, undefined as any),
      ).rejects.toThrow(/несколько/i);
    } finally {
      removeClient(владелецId(), первый.socket as any);
      removeClient(владелецId(), второй.socket as any);
    }
  });

  it("связь с телефоном потеряна посреди команды — висящий вызов падает сразу", async () => {
    const { socket } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    const обещание = runDeviceOp(DEVICE_ID, "reminder.list", {}, { timeoutMs: 5000 });
    removeClient(владелецId(), socket as any);
    await expect(обещание).rejects.toThrow(/связь/i);
  });

  it("ответ на чужой opId игнорируется и ничего не ломает", () => {
    expect(
      handleDeviceOpResult({
        type: "device_op_result",
        opId: "неизвестный",
        ok: true,
        data: {},
      }),
    ).toBe(true);
    expect(handleDeviceOpResult({ type: "пинг" })).toBe(false);
  });

  it("удаление не стирает: команда на телефон не уходит вовсе", async () => {
    const { socket, кадры } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      await expect(
        инструментПо("apple_reminders_delete").execute("1", { id: "r1" }, undefined as any),
      ).rejects.toThrow(/Удаление недоступно/i);
      await подождать(20);
      expect(кадры.filter((к) => к.type === "device_op")).toHaveLength(0);
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });

  it("живой сокет устройства виден списком живых устройств", () => {
    const { socket } = фейковыйСокет();
    addClient(владелецId(), socket as any, DEVICE_ID);
    try {
      expect(liveDeviceIds()).toContain(DEVICE_ID);
    } finally {
      removeClient(владелецId(), socket as any);
    }
  });
});
