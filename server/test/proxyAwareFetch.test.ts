import { afterEach, describe, expect, it, vi } from "vitest";

describe("installProxyAwareGlobalFetch", () => {
  const originalFetch = globalThis.fetch;
  const envKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  function stashEnv() {
    for (const key of envKeys) saved[key] = process.env[key];
  }

  it("adds EnvHttpProxyAgent dispatcher when fetch has none", async () => {
    stashEnv();
    for (const key of envKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:10813";

    const inner = vi.fn(async () => new Response("ok"));
    globalThis.fetch = inner as unknown as typeof fetch;

    const { installProxyAwareGlobalFetch } = await import("../src/runtime/providerDiagnostics.js");
    installProxyAwareGlobalFetch();

    await globalThis.fetch("https://auth.x.ai/oauth2/device/code", {
      method: "POST",
      body: "client_id=test",
    });

    expect(inner).toHaveBeenCalledTimes(1);
    const init = inner.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeTruthy();
  });

  it("does not replace an explicit dispatcher", async () => {
    stashEnv();
    for (const key of envKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:10813";

    const marker = { kind: "explicit" };
    const inner = vi.fn(async () => new Response("ok"));
    globalThis.fetch = inner as unknown as typeof fetch;

    const { installProxyAwareGlobalFetch } = await import("../src/runtime/providerDiagnostics.js");
    installProxyAwareGlobalFetch();

    await globalThis.fetch("https://example.org", { dispatcher: marker } as RequestInit);

    const init = inner.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBe(marker);
  });

  it("is a no-op when HTTPS_PROXY is unset", async () => {
    stashEnv();
    for (const key of envKeys) delete process.env[key];

    const inner = vi.fn(async () => new Response("ok"));
    globalThis.fetch = inner as unknown as typeof fetch;

    const { installProxyAwareGlobalFetch } = await import("../src/runtime/providerDiagnostics.js");
    installProxyAwareGlobalFetch();

    expect(globalThis.fetch).toBe(inner);
    await globalThis.fetch("https://example.org");
    expect(inner.mock.calls[0]?.[1]).toBeUndefined();
  });
});
