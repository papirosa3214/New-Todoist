// withOwnAuthConfigs (scripts/composio_mcp.mjs): свои ключи владельца (Exa и
// подобные) подставляются только для сервисов, включённых у роли. 28.10.2026
// у разработчика включён лишь GitHub, а в сессию уезжал ключ Exa — Composio
// отвечал 400 «Auth config overrides contain toolkit slugs not in the enabled
// list», и шаги разработчика падали на старте.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs без типов
import { withOwnAuthConfigs } from "../scripts/composio_mcp.mjs";

const composio = {
  connectedAccounts: {
    list: async () => ({
      items: [
        { toolkit: { slug: "exa" }, authConfig: { id: "ac_exa", isComposioManaged: false } },
        { toolkit: { slug: "github" }, authConfig: { id: "ac_gh", isComposioManaged: true } },
      ],
    }),
  },
};

describe("withOwnAuthConfigs", () => {
  it("не подставляет ключ сервиса, который у роли не включён", async () => {
    const options = { mcp: true, toolkits: { enable: ["github", "github_mcp"] } };
    const result = await withOwnAuthConfigs(composio, "taskflow:u1", options);
    expect(result.authConfigs ?? {}).not.toHaveProperty("exa");
  });

  it("подставляет ключ включённого сервиса", async () => {
    const options = { mcp: true, toolkits: { enable: ["exa", "github"] } };
    const result = await withOwnAuthConfigs(composio, "taskflow:u1", options);
    expect(result.authConfigs).toEqual({ exa: "ac_exa" });
  });

  it("без списка сервисов (каталог) подставляет все свои ключи", async () => {
    const result = await withOwnAuthConfigs(composio, "taskflow:u1", { mcp: true });
    expect(result.authConfigs).toEqual({ exa: "ac_exa" });
  });
});
