import { describe, expect, it } from "vitest";
import { SERVER_SETTINGS, SETTING_GROUP_ORDER, DEFAULTS, envOverride } from "./serverSettingsRegistry.js";

// Тумблеры очередей чата (владелец 14.11.2026): «Откладывать сообщение, пока
// роль отвечает» и «Журнал доставки ходов чата» — оба в группе «чаты» и
// включены по умолчанию, поведение прежнее. Реестр чистый: БД и сервисы не
// нужны.
describe("тумблеры очередей чата", () => {
  const keys = ["chat_queue_defer_enabled", "chat_delivery_journal_enabled"] as const;

  it("оба тумблера объявлены в группе «чаты» как bool", () => {
    for (const key of keys) {
      const meta = SERVER_SETTINGS.find((s) => s.key === key);
      expect(meta, key).toBeDefined();
      expect(meta!.kind).toBe("bool");
      expect(meta!.group).toBe("чаты");
      expect(meta!.default).toBe(true);
      expect(meta!.label.length).toBeGreaterThan(10);
    }
    expect(SETTING_GROUP_ORDER).toContain("чаты");
  });

  it("дефолты включены: прежнее поведение без единой записи в БД", () => {
    expect(DEFAULTS.chat_queue_defer_enabled).toBe(true);
    expect(DEFAULTS.chat_delivery_journal_enabled).toBe(true);
  });

  it("каждый ключ реестра имеет запись в DEV_OVERRIDES-источнике", () => {
    for (const key of keys) {
      const overridden = envOverride(key, DEFAULTS[key]);
      expect(typeof overridden).toBe("boolean");
    }
  });
});
