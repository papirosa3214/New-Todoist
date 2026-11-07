import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const original = process.env.TASKFLOW_LAN_CERT_DIR;
const dirs: string[] = [];

function certDir(withFiles: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-ca-"));
  dirs.push(dir);
  if (withFiles) {
    fs.writeFileSync(path.join(dir, "lan.pem"), "CERT");
    fs.writeFileSync(path.join(dir, "lan-key.pem"), "KEY");
  }
  return dir;
}

async function load(dir: string) {
  vi.resetModules();
  process.env.TASKFLOW_LAN_CERT_DIR = dir;
  return (await import("../vite.config")).default as any;
}

const pluginNames = (config: any): string[] =>
  config.plugins.flat(Infinity).map((plugin: any) => plugin?.name);

afterEach(() => {
  if (original === undefined) delete process.env.TASKFLOW_LAN_CERT_DIR;
  else process.env.TASKFLOW_LAN_CERT_DIR = original;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("сертификат dev-сервера", () => {
  it("есть сертификат локального CA: HTTPS идёт через него", async () => {
    const config = await load(certDir(true));
    expect(String(config.server.https.cert)).toBe("CERT");
    expect(String(config.server.https.key)).toBe("KEY");
    expect(pluginNames(config)).not.toContain("vite:basic-ssl");
  });

  it("сертификата нет: конфиг грузится и HTTPS остаётся через basicSsl", async () => {
    const config = await load(certDir(false));
    expect(config.server.https).toBeUndefined();
    expect(pluginNames(config)).toContain("vite:basic-ssl");
    expect(config.server.proxy["/api"]).toBeDefined();
  });
});
