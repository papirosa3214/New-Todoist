import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { resolveUserId } from "../src/auth.js";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

beforeAll(() => { migrate(); runMigrations(); });
describe("server audit: JWT actor existence", () => {
  it("rejects an otherwise valid signed JWT for an absent user", async () => {
    const app = Fastify();
    await app.register(jwt, { secret: process.env.JWT_SECRET! });
    try {
      const token = app.jwt.sign({ id: "audit-deleted-user" });
      expect(resolveUserId(app, token)).toBeNull();
    } finally { await app.close(); }
  });
});
