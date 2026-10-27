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
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import { ROLE_NAMES } from "../src/roleRouting.js";
import { saveComposioPolicy } from "../src/runtime/composioPolicy.js";
import { inspectComposio } from "../src/runtime/composioRuntime.js";
import { clearComposioCache } from "../src/runtime/roleIntegrations.js";

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
  // Копия каталога живёт минуту: без сброса один тест читал бы ответ другого.
  beforeEach(() => clearComposioCache());

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
      items: [{ slug: "todoist", name: "Todoist", logo: "https://logos.composio.dev/api/todoist", connected: true, noAuth: false }],
    } as any);
    const res = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.catalog).toEqual([{ slug: "todoist", name: "Todoist", logo: "https://logos.composio.dev/api/todoist", description: null, connected: true, noAuth: false }]);
    expect(body.roles).toEqual(
      expect.arrayContaining([{ role, enabled: true, toolkits: ["linear"] }]),
    );
  });

  it("сводка отдаёт сервис роли по ключу, даже если его нет на первой странице каталога", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["todoist"] });
    // Первая страница каталога todoist не содержит — так и бывает у Composio.
    vi.mocked(inspectComposio).mockImplementation(async (_policy: any, _action: any, search = "") => {
      if (search === "todoist") {
        return { items: [{ slug: "todoist", name: "Todoist", connected: true, noAuth: false }] } as any;
      }
      return { items: [{ slug: "gmail", name: "Gmail", connected: true, noAuth: false }] } as any;
    });
    const res = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalog.map((item: any) => item.slug)).toEqual(["gmail"]);
    expect(body.services).toEqual([
      { slug: "todoist", name: "Todoist", logo: null, description: null, connected: true, noAuth: false },
    ]);
  });

  it("сводка листается постранично: курсор уходит в Composio и возвращается наверх", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["todoist"] });
    const seen: Array<{ search: string; cursor?: string | null; limit?: number }> = [];
    vi.mocked(inspectComposio).mockImplementation(async (_policy: any, _action: any, search = "", page?: any) => {
      seen.push({ search, cursor: page?.cursor ?? null, limit: page?.limit });
      if (page?.cursor === "page-2") {
        return { items: [{ slug: "notion", name: "Notion", connected: false, noAuth: false }], cursor: null, totalPages: 34 } as any;
      }
      return { items: [{ slug: "gmail", name: "Gmail", connected: true, noAuth: false }], cursor: "page-2", totalPages: 34 } as any;
    });
    const first = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(ownerToken) });
    expect(first.statusCode).toBe(200);
    expect(first.json().catalog.map((item: any) => item.slug)).toEqual(["gmail"]);
    expect(first.json().catalogCursor).toBe("page-2");
    expect(first.json().catalogTotalPages).toBe(34);

    const second = await app.inject({ method: "GET", url: "/api/integrations/composio?cursor=page-2", headers: auth(ownerToken) });
    expect(second.statusCode).toBe(200);
    expect(second.json().catalog.map((item: any) => item.slug)).toEqual(["notion"]);
    expect(second.json().catalogCursor).toBeNull();
    expect(seen.some((call) => call.cursor === "page-2")).toBe(true);
  });

  it("сводка не выдумывает подключение, когда Composio не ответил", async () => {
    saveComposioPolicy({ role, ownerId, enabled: true, toolkits: ["todoist"] });
    vi.mocked(inspectComposio).mockRejectedValue(new Error("Composio не отвечает"));
    const res = await app.inject({ method: "GET", url: "/api/integrations/composio", headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.services).toEqual([]);
    expect(body.error).toContain("Composio");
  });
});
