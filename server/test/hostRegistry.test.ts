// Реестр машин и выдача ключа машине (тикет 1 «Сервер: реестр машин и шлюз
// хостов», план taskflow-host, решения D4 и D7).
//
// Проверяется ровно то, что обещает документ: в базе лежит только sha256
// ключа, машина находится по ключу, отзыв делает её непринимаемой — и
// повторный отзыв не ошибка, потому что «уже отозвано» это тот же результат.
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import db, { hashApiToken, migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  findMachineByToken,
  issueMachineKey,
  listMachines,
  revokeMachine,
} from "../src/host/machines.js";

describe("Реестр машин: выдача ключа и отзыв", () => {
  // Тест живого слоя БД, а не HTTP: схему поднимаем сами. В приложении это
  // делает buildApp (index.ts), но до него тут нет дела — а таблица machines
  // должна появиться от обычного прогона миграций, как и все остальные.
  beforeAll(() => {
    migrate();
    runMigrations();
  });

  // Имя живой машины уникально, а тесты переиспользуют одно и то же — чистим
  // таблицы между ними, иначе второй тест упёрся бы в UNIQUE не из-за своей
  // логики, а из-за предыдущего.
  beforeEach(() => {
    db.prepare("DELETE FROM machine_events").run();
    db.prepare("DELETE FROM machines").run();
  });
  it("выданный ключ находит свою машину", () => {
    const { machine, token } = issueMachineKey({
      name: "mac",
      allowedRoots: ["/Users/max"],
      platform: "darwin",
    });

    expect(machine.id).toBeTruthy();
    expect(machine.name).toBe("mac");
    expect(machine.allowed_roots).toEqual(["/Users/max"]);

    const найденная = findMachineByToken(token);
    expect(найденная?.id).toBe(machine.id);
    expect(найденная?.name).toBe("mac");
  });

  it("чужой ключ не находит ни одной машины", () => {
    issueMachineKey({ name: "mac", allowedRoots: ["/Users/max"] });

    expect(findMachineByToken("tfh_не_наш_ключ")).toBeNull();
  });

  it("в базе лежит только sha256 ключа и его префикс — сам ключ не хранится", () => {
    const { token } = issueMachineKey({ name: "mac", allowedRoots: ["/Users/max"] });
    const строка = db
      .prepare("SELECT token_hash, token_prefix FROM machines WHERE token_prefix = ?")
      .get(token.slice(0, 8)) as { token_hash: string; token_prefix: string };

    expect(строка.token_hash).toBe(hashApiToken(token));
    expect(строка.token_prefix).toBe(token.slice(0, 8));
    // Ключ целиком не должен встречаться ни в одной колонке machines.
    const всё = db.prepare("SELECT * FROM machines").all() as Array<Record<string, unknown>>;
    for (const строка2 of всё) {
      expect(Object.values(строка2)).not.toContain(token);
    }
  });

  it("отзыв делает машину непринимаемой: старый ключ больше не входит", () => {
    const { machine, token } = issueMachineKey({
      name: "mac",
      allowedRoots: ["/Users/max"],
    });
    expect(findMachineByToken(token)?.id).toBe(machine.id);

    revokeMachine(machine.id, "машина сгорела");

    expect(findMachineByToken(token)).toBeNull();
  });

  it("повторный отзыв не ошибка — тот же результат", () => {
    const { machine } = issueMachineKey({ name: "mac", allowedRoots: ["/Users/max"] });

    expect(revokeMachine(machine.id, "раз")).toBe(true);
    expect(revokeMachine(machine.id, "два")).toBe(false);
    expect(revokeMachine("машины-нет")).toBe(false);
  });

  it("список машин отдаёт и отозванные, помечая их revoked_at", () => {
    const живая = issueMachineKey({ name: "mac", allowedRoots: ["/Users/max"] });
    revokeMachine(живая.machine.id, "проверка");

    const все = listMachines();
    const строка = все.find((м) => м.id === живая.machine.id);
    expect(строка?.revoked_at).toBeTruthy();
    expect(строка?.revoke_reason).toBe("проверка");
  });
});