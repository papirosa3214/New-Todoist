// Канал «разбудить оркестратора» выключен по умолчанию (владелец 08.11.2026:
// «не надо, чтобы уже будили оркестратора, у меня уведомления приходят»).
// Тест держит контракт: без явного флага сервер не отдаёт события приёмнику
// оркестратора, а «Заминки»-чаты этой работой больше не открываются.
import { describe, expect, it } from "vitest";
import { orchestratorWebhookEnabled } from "../src/lib/orchestratorWebhook.js";

describe("orchestrator webhook gate", () => {
  it("молчит, когда флаг не выставлен", () => {
    expect(orchestratorWebhookEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("говорит только при явном включении", () => {
    expect(orchestratorWebhookEnabled({ ORCHESTRATOR_WEBHOOK_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("выключение сильнее включения", () => {
    expect(
      orchestratorWebhookEnabled({
        ORCHESTRATOR_WEBHOOK_ENABLED: "1",
        ORCHESTRATOR_WEBHOOK_DISABLED: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
