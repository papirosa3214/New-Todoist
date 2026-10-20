/**
 * Интеграции в профиле роли (карточка cc849a6d, 20.10.2026).
 *
 * Проверяем то, что видно владельцу на карточке роли:
 *   - каталог подключений приходит из того же источника, что и
 *     GET /api/roles/:role/composio (тот же inspectComposio), и в профиле
 *     роли видно, подключён сервис или нет;
 *   - когда каталог не пришёл, состояние остаётся НЕИЗВЕСТНЫМ, а не
 *     «не подключено»: разница видна глазом и враньём хуже, чем пустота;
 *   - профиль роли читают и не владельцы (это общий профиль роли), а
 *     сводка по Composio с подключениями — только владельцу;
 *   - выключенная роль не дёргает Composio зря.
 */
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import { ROLE_NAMES } from "../src/roleRouting.js";
import { saveComposioPolicy } from "../src/runtime/composioPolicy.js";
import { inspectComposio } from "../src/runtime/composioRuntime.js";

vi.mock("../src/runtime/composioRuntime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime/composioRuntime.js")>(),
  inspectComposio: vi.fn(async () => ({ items: [] })),
}));

describe("интеграции в профиле роли", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string, memberToken: string, ownerId: string;
  const role = ROLE_NAMES[0];
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-fixture-key");
    app = await buildApp();
    for (const kind of ["owner", "member"]) {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: kind, email: `${kind}-${Date.now()}@role-integrations.test`, password: "password123" },
      });
      if (kind === "owner") {
        ownerToken = result.json().token;
        ownerId = result.json().user.id;
        const { default: db } = await import("../src/db.js");
        db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
      } else {
        memberToken = result.json().token;
      }
    }
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("отдаёт разрешённые сервисы и их состояние из каталога Composio", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["todoist"] });
    vi.mocked(inspectComposio).mockResolvedValue({
      items: [{ slug: "todoist", name: "Todoist", connected: true, noAuth: false }],
    } as any);
    const res = await app.inject({ method: "GET", url: `/api/roles/${role}`, headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrations).toMatchObject({
      enabled: true,
      connected_known: true,
      error: null,
      toolkits: [{ slug: "todoist", name: "Todoist", connected: true }],
    });
  });

  it("не выдаёт «не подключено», когда каталог не пришёл: состояние неизвестно", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["github"] });
    vi.mocked(inspectComposio).mockRejectedValue(new Error("Composio не отвечает или ключ недействителен"));
    const res = await app.inject({ method: "GET", url: `/api/roles/${role}`, headers: auth(ownerToken) });
    const integrations = res.json().integrations;
    expect(integrations.connected_known).toBe(false);
    expect(integrations.toolkits[0]).toMatchObject({ slug: "github", connected: null });
    expect(integrations.error).toContain("Composio");
  });

  it("выключенная роль не спрашивает каталог: сервисы разрешены, состояние не важно", async () => {
    saveComposioPolicy({ role, ownerId, enabled: false, toolkits: ["linear"] });
    vi.mocked(inspectComposio).mockClear();
    const res = await app.inject({ method: "GET", url: `/api/roles/${role}`, headers: auth(ownerToken) });
    expect(res.json().integrations).toMatchObject({ enabled: false, toolkits: [{ slug: "linear" }] });
    expect(vi.mocked(inspectComposio)).not.toHaveBeenCalled();
  });

  it("профиль роли читают и не владельцы, а сводка по Composio — только владельцу", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["linear"] });
    vi.mocked(inspectComposio).mockResolvedValue({
      items: [{ slug: "linear", name: "Linear", connected: false, noAuth: false }],
    } as any);
    const member = await app.inject({ method: "GET", url: `/api/roles/${role}`, headers: auth(memberToken) });
    expect(member.statusCode).toBe(200);
    expect(member.json().integrations.toolkits[0]).toMatchObject({ slug: "linear", connected: false });

    const summary = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(memberToken) });
    expect(summary.statusCode).toBe(403);
  });

  it("сводка по Composio у владельца: каталог, роли и их политики", async () => {
    vi.mocked(inspectComposio).mockResolvedValue({
      items: [{ slug: "todoist", name: "Todoist", connected: true, noAuth: false }],
    } as any);
    const res = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.catalog).toEqual([{ slug: "todoist", name: "Todoist", connected: true, noAuth: false }]);
    expect(body.roles).toEqual(
      expect.arrayContaining([{ role, enabled: true, toolkits: ["linear"] }]),
    );
  });
});
