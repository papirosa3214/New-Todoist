// Мост /api/secrets → Agent Secret Broker /owner-api (routes/secrets.ts).
// Брокер подменён маленьким HTTP-сервером; токен — временный файл.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

const PHONE = "192.168.1.57";
const TOKEN = "broker-owner-token-for-tests";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = "";
let otherToken = "";
let broker: http.Server;
const secrets = new Map<string, { name: string; origin: string; header_name: string; value: string }>();
const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];

async function register(name: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
  });
  const body = res.json();
  return { id: body.user.id, token: body.token };
}

function call(method: string, url: string, token: string, payload?: unknown, remoteAddress = PHONE) {
  return app.inject({ method: method as any, url, remoteAddress, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
}

beforeAll(async () => {
  broker = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
      const m = req.url!.match(/^\/owner-api\/secrets(?:\/([^/]+))?(\/reveal)?$/);
      if (!m) return send(404, { error: "not found" });
      const id = m[1] && decodeURIComponent(m[1]);
      if (req.method === "GET" && !id) {
        return send(200, { secrets: [...secrets].map(([sid, s]) => ({ id: sid, name: s.name, origin: s.origin, header_name: s.header_name })) });
      }
      if (req.method === "PUT" && id) {
        const b = JSON.parse(raw);
        secrets.set(id, { ...b, header_name: b.header_name || "Authorization" });
        const s = secrets.get(id)!;
        return send(200, { id, name: s.name, origin: s.origin, header_name: s.header_name });
      }
      if (req.method === "POST" && id && m[2]) {
        const s = secrets.get(id);
        return s ? send(200, { value: s.value }) : send(404, { error: "not found" });
      }
      if (req.method === "DELETE" && id) {
        if (!secrets.delete(id)) return send(404, { error: "not found" });
        res.writeHead(204);
        return res.end();
      }
      send(405, { error: "method" });
    });
  });
  await new Promise<void>((r) => broker.listen(0, "127.0.0.1", r));
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tf-secrets-")), "token");
  fs.writeFileSync(tokenFile, TOKEN + "\n", { mode: 0o600 });
  process.env.TASKFLOW_SECRET_BROKER_URL = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  process.env.TASKFLOW_SECRET_BROKER_TOKEN_PATH = tokenFile;

  app = await buildApp();
  seedRoleAccounts(db);
  db.prepare("UPDATE users SET role='viewer' WHERE role='owner'").run();
  const owner = await register("secrets-owner");
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.id);
  ownerToken = owner.token;
  otherToken = (await register("secrets-other")).token;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => broker.close(() => r()));
  delete process.env.TASKFLOW_SECRET_BROKER_URL;
  delete process.env.TASKFLOW_SECRET_BROKER_TOKEN_PATH;
});

describe("/api/secrets — мост к хранилищу секретов", () => {
  it("владелец с телефона: запись, список без значений, просмотр, удаление", async () => {
    const put = await call("PUT", "/api/secrets/openai", ownerToken, { name: "OpenAI", origin: "api.openai.com/v1", value: "sk-canary" });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: "openai", header_name: "Authorization" });

    const list = await call("GET", "/api/secrets", ownerToken);
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.body).not.toContain("sk-canary");
    expect(list.json().secrets.map((s: any) => s.id)).toEqual(["openai"]);

    const reveal = await call("POST", "/api/secrets/openai/reveal", ownerToken);
    expect(reveal.json()).toEqual({ value: "sk-canary" });

    expect((await call("DELETE", "/api/secrets/openai", ownerToken)).statusCode).toBe(204);
    expect((await call("POST", "/api/secrets/openai/reveal", ownerToken)).statusCode).toBe(404);
    expect(seen.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("не владельцу — 403, брокер не вызывается", async () => {
    const before = seen.length;
    expect((await call("GET", "/api/secrets", otherToken)).statusCode).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("запрос с самого .110 (там работают роли) — 403 даже владельцу", async () => {
    const before = seen.length;
    for (const addr of ["127.0.0.1", "192.168.1.110"]) {
      expect((await call("POST", "/api/secrets/openai/reveal", ownerToken, undefined, addr)).statusCode).toBe(403);
    }
    expect(seen.length).toBe(before);
  });

  it("кривой id и пустые поля — 400 до брокера", async () => {
    const before = seen.length;
    expect((await call("PUT", "/api/secrets/..%2Fx", ownerToken, { name: "a", origin: "b", value: "c" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/secrets/ok", ownerToken, { name: "a", origin: "", value: "c" })).statusCode).toBe(400);
    expect(seen.length).toBe(before);
  });
});
