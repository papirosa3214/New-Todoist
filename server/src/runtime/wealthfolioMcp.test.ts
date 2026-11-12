import { afterEach, describe, expect, it } from "vitest";
import {
  WEALTHFOLIO_ROLE,
  connectWealthfolio,
  wealthfolioRoleAllowed,
  wealthfolioStatus,
  wealthfolioToolName,
  wealthfolioUrl,
} from "./wealthfolioMcp.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  delete process.env.TASKFLOW_WEALTHFOLIO_MCP_URL;
  delete process.env.TASKFLOW_WEALTHFOLIO_TOKEN;
});

describe("wealthfolio MCP", () => {
  it("открыт только помощнику владельца", () => {
    expect(WEALTHFOLIO_ROLE).toBe("secretary");
    expect(wealthfolioRoleAllowed("secretary")).toBe(true);
    expect(wealthfolioRoleAllowed("infra_engineer")).toBe(false);
    expect(wealthfolioRoleAllowed("role_backend")).toBe(false);
  });

  it("называет инструменты своим префиксом", () => {
    expect(wealthfolioToolName("get_accounts")).toBe("wealthfolio_get_accounts");
  });

  it("по умолчанию ходит по loopback на .110", () => {
    delete process.env.TASKFLOW_WEALTHFOLIO_MCP_URL;
    expect(wealthfolioUrl()).toBe("http://127.0.0.1:8095/mcp");
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:9999/mcp";
    expect(wealthfolioUrl()).toBe("http://127.0.0.1:9999/mcp");
  });

  it("не подключается для чужой роли и не ходит в сеть", async () => {
    // Адрес заведомо недоступен: если бы гейт по роли не сработал, тест упал бы.
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:1/mcp";
    const connected = await connectWealthfolio("infra_engineer");
    expect(connected.tools).toEqual([]);
    await expect(connected.close()).resolves.toBeUndefined();
  });

  it("сбой подключения виден вызывающему и не светит токен", async () => {
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:1/mcp";
    process.env.TASKFLOW_WEALTHFOLIO_TOKEN = "s3cr3t-token-value";
    await expect(connectWealthfolio("secretary")).rejects.toSatisfy((error: Error) =>
      typeof error?.message === "string" && !error.message.includes("s3cr3t-token-value"),
    );
  });

  it("снимок для «Интеграций» честно говорит «не подключено» и не светит токен", async () => {
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:7/mcp";
    process.env.TASKFLOW_WEALTHFOLIO_TOKEN = "s3cr3t-token-value";
    const status = await wealthfolioStatus(0);
    expect(status.connected).toBe(false);
    expect(status.toolCount).toBe(0);
    expect(status.url).toBe("http://127.0.0.1:7/mcp");
    expect(String(status.error)).not.toContain("s3cr3t-token-value");
  });

  it("кеш не переспрашивает трекер, но и не врёт при смене адреса", async () => {
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:7/mcp";
    process.env.TASKFLOW_WEALTHFOLIO_TOKEN = "t";
    const first = await wealthfolioStatus(60_000);
    const second = await wealthfolioStatus(60_000);
    expect(second).toBe(first);
    process.env.TASKFLOW_WEALTHFOLIO_MCP_URL = "http://127.0.0.1:8/mcp";
    const third = await wealthfolioStatus(60_000);
    expect(third.url).toBe("http://127.0.0.1:8/mcp");
    expect(third).not.toBe(first);
  });
});
