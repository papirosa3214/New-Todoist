import { describe, expect, it, beforeEach } from "vitest";
import {
  changedetectionRoleAllowed,
  changedetectionStatus,
  changedetectionToolName,
  changedetectionUrl,
} from "./changedetectionMcp.js";

describe("changedetection MCP", () => {
  beforeEach(() => {
    delete process.env.TASKFLOW_CHANGEDETECTION_MCP_URL;
  });

  it("доступен любой роли: слежение за страницами нужно не только Помощнику", () => {
    expect(changedetectionRoleAllowed("secretary")).toBe(true);
    expect(changedetectionRoleAllowed("analyst")).toBe(true);
    expect(changedetectionRoleAllowed("builder")).toBe(true);
    expect(changedetectionRoleAllowed("infra_engineer")).toBe(true);
  });

  it("имя инструмента получает префикс — иначе он не уйдёт в загрузку по требованию", () => {
    expect(changedetectionToolName("get_changes")).toBe("changedetection_get_changes");
  });

  it("адрес по умолчанию — loopback .110, env перекрывает", () => {
    expect(changedetectionUrl()).toBe("http://127.0.0.1:5000/mcp/v1");
    process.env.TASKFLOW_CHANGEDETECTION_MCP_URL = "http://127.0.0.1:9999/mcp";
    expect(changedetectionUrl()).toBe("http://127.0.0.1:9999/mcp");
  });

  it("без токена статус не врёт про подключение", async () => {
    process.env.TASKFLOW_CHANGEDETECTION_TOKEN = "";
    process.env.TASKFLOW_CHANGEDETECTION_VAULT_KEY = "нет_такого_ключа_в_хранилище";
    process.env.TASKFLOW_VAULT_GET = "/bin/false";
    const status = await changedetectionStatus(0);
    expect(status.connected).toBe(false);
    expect(status.toolCount).toBe(0);
    expect(status.error).toBeTruthy();
  });
});
