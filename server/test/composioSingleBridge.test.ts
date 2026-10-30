/**
 * Состояние подключения разрешённых ролям сервисов — ОДНИМ внешним процессом.
 *
 * Замер 30.10.2026 на .110: маршрут обзора (GET /api/integrations/composio)
 * делал 9 внешних процессов Composio — каталог плюс по одному на каждый из
 * 8 ключей, разрешённых ролям. На пике висело 18 мостов, ответ занимал
 * 5,6–6,2 с, и телефон на экране «Интеграции» ждал эти секунды.
 *
 * Теперь все ключи спрашиваются одним вызовом: мост ищет их внутри одной
 * сессии (замер: 1 405 мс вместо 5 600 мс, все 8 ключей найдены).
 *
 * Проверяем, что это РЕАЛЬНО один вызов, а не восемь под видом одного, и
 * что ответ моста приходит в том же виде, что и прежние постраничные ответы.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { inspectComposio, inspectComposioSlugs } from "../src/runtime/composioRuntime.js";
import { resolveToolkits, clearComposioCache } from "../src/runtime/roleIntegrations.js";

vi.mock("../src/runtime/composioRuntime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime/composioRuntime.js")>(),
  inspectComposio: vi.fn(async () => ({ items: [] })),
  inspectComposioSlugs: vi.fn(async () => ({ items: [] })),
}));

const SLUGS = ["composio", "exa", "github", "github_mcp", "linear", "reddit", "todoist", "youtube"];

describe("состояние сервисов ролей одним вызовом", () => {
  beforeEach(() => {
    clearComposioCache();
    vi.mocked(inspectComposio).mockClear();
    vi.mocked(inspectComposioSlugs).mockClear();
  });

  it("спрашивает все ключи ОДНИМ вызовом, а не по процессу на ключ", async () => {
    vi.mocked(inspectComposioSlugs).mockResolvedValue({
      items: SLUGS.map(slug => ({
        slug,
        name: slug.toUpperCase(),
        logo: null,
        description: null,
        connected: slug === "github",
        noAuth: false,
      })),
    });

    const result = await resolveToolkits("u1", SLUGS);

    // Ровно один внешний вызов на весь список ключей.
    expect(vi.mocked(inspectComposioSlugs)).toHaveBeenCalledTimes(1);
    // По ключу — ни одного отдельного вызова каталога.
    expect(vi.mocked(inspectComposio)).not.toHaveBeenCalled();
    // В вызов ушли все ключи.
    expect(vi.mocked(inspectComposioSlugs).mock.calls[0][1]).toEqual(SLUGS);
    // Ответ собран полностью и состояние подключения на месте.
    expect(result.items).toHaveLength(SLUGS.length);
    expect(result.error).toBeNull();
    expect(result.items.find(item => item.slug === "github")?.connected).toBe(true);
    expect(result.items.find(item => item.slug === "todoist")?.connected).toBe(false);
  });

  it("повторяющиеся ключи схлопываются в один запрос", async () => {
    vi.mocked(inspectComposioSlugs).mockResolvedValue({ items: [] });
    await resolveToolkits("u1", ["github", "github", "todoist", "github"]);
    expect(vi.mocked(inspectComposioSlugs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inspectComposioSlugs).mock.calls[0][1]).toEqual(["github", "todoist"]);
  });

  it("пустой список ключей не порождает ни одного вызова", async () => {
    const result = await resolveToolkits("u1", []);
    expect(vi.mocked(inspectComposioSlugs)).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], error: null });
  });

  it("сбой Composio даёт честную ошибку, а не пустой молчаливый список", async () => {
    vi.mocked(inspectComposioSlugs).mockRejectedValue(new Error("Composio не отвечает или ключ недействителен."));
    const result = await resolveToolkits("u1", ["github"]);
    expect(result.items).toEqual([]);
    expect(result.error).toContain("Composio");
  });
});
