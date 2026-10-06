import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { roleHome, renderSystemPrompt } from "../src/runtime/roleHome.js";
import { allRoles, colleagueList } from "../src/roleRouting.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe("список коллег в инструкции роли (MAK-99)", () => {
  it("собран из профилей, совпадает с реестром ролей и не включает самого себя", () => {
    const role = "builder";
    const text = renderSystemPrompt(role, roleHome(role));
    expect(text).not.toContain("{{TEAM}}");
    expect(text).toContain(colleagueList(role));
    for (const profile of allRoles().filter((r) => r.enabled && r.key !== role)) {
      expect(text, profile.key).toContain(`${profile.key} — ${profile.title}: ${profile.summary}`);
    }
    expect(text).not.toContain(`- ${role} — `);
    expect(text).toContain("ленту темы не публикует");
    expect(text).toContain("[SILENT]");
  });
});
