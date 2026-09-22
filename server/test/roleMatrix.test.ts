// Матрица прав: маппинг profile → 7 ролей, расширенный isReviewer,
// agent-service (owner + orchestrator). Карточка b6b57092.
//
// Здесь три уровня:
//   - прямые вызовы getRole() / isReviewer() — без HTTP, проверяем
//     маппинг PROFILE_ROLE и двойной путь ревьюера;
//   - HTTP POST /api/agent-service от агента → 403, от orchestrator → не
//     403 (до хендлера с systemctl не доходит, нас интересует только
//     preHandler-ворота, потому что именно их мы правили).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { getRole, isReviewer } from "../src/access.js";

describe("Матрица прав: роли и профили (b6b57092)", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let orchId: string;
  let agentId: string;
  let reviewerNoFlagId: string;

  beforeAll(async () => {
    app = await buildApp();

    async function regAndPatch(
      email: string,
      name: string,
      patch?: { role?: string; type?: string; profile?: string; reviewer?: number },
    ): Promise<string> {
      const reg = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name, email, password: "password123" },
      });
      expect(reg.statusCode).toBe(200);
      const id = reg.json().user.id as string;
      if (patch?.role)
        db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
      if (patch?.type)
        db.prepare("UPDATE users SET type = ? WHERE id = ?").run(patch.type, id);
      if (patch?.profile)
        db.prepare("UPDATE users SET profile = ? WHERE id = ?").run(patch.profile, id);
      if (patch?.reviewer !== undefined)
        db.prepare("UPDATE users SET reviewer = ? WHERE id = ?").run(
          patch.reviewer,
          id,
        );
      return id;
    }

    ownerId = await regAndPatch("matrix-owner@test", "MatrixOwner", {
      role: "owner",
    });
    orchId = await regAndPatch("matrix-orch@test", "MatrixOrch", {
      role: "orchestrator",
      profile: "orchestrator",
    });
    agentId = await regAndPatch("matrix-agent@test", "MatrixAgent", {
      type: "ai",
      profile: "claude_bot",
    });
    // Ревьюер БЕЗ узкого флага reviewer=1 — только через profile.
    // Демонстрирует второй путь, который мы добавили расширением isReviewer.
    reviewerNoFlagId = await regAndPatch(
      "matrix-rev@test",
      "MatrixReviewerNoFlag",
      { type: "ai", profile: "reviewer" },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────
  // getRole() — прямые вызовы, без HTTP
  // ─────────────────────────────────────────────────────────────────────

  describe("getRole: маппинг profile → роль из семи", () => {
    it("profile='claude_bot' → Builder", () => {
      expect(getRole(agentId)).toBe("Builder");
    });

    it("profile='reviewer' → Critic/Verifier (закрывает и QA)", () => {
      expect(getRole(reviewerNoFlagId)).toBe("Critic/Verifier");
    });

    it("profile='orchestrator' → Architect", () => {
      expect(getRole(orchId)).toBe("Architect");
    });

    it("profile='deepseek' → Researcher", () => {
      const id = (
        db.prepare("SELECT id FROM users WHERE email = ?").get(
          "matrix-owner@test",
        ) as { id?: string }
      )?.id;
      expect(id).toBeTruthy();
      // Создадим прямо здесь через UPDATE — нам важен profile, не регистрация.
      db.prepare("UPDATE users SET profile = 'deepseek' WHERE id = ?").run(
        reviewerNoFlagId,
      );
      expect(getRole(reviewerNoFlagId)).toBe("Researcher");
      // Откатим, чтобы не сломать тест isReviewer ниже.
      db.prepare("UPDATE users SET profile = 'reviewer' WHERE id = ?").run(
        reviewerNoFlagId,
      );
    });

    it("profile=NULL → null (учётка без профиля, ничего не сломано)", () => {
      db.prepare("UPDATE users SET profile = NULL WHERE id = ?").run(agentId);
      expect(getRole(agentId)).toBeNull();
      db.prepare("UPDATE users SET profile = 'claude_bot' WHERE id = ?").run(
        agentId,
      );
    });

    it("profile неизвестный → null (не падаем, не выдумываем роль)", () => {
      db.prepare("UPDATE users SET profile = 'mystery' WHERE id = ?").run(agentId);
      expect(getRole(agentId)).toBeNull();
      db.prepare("UPDATE users SET profile = 'claude_bot' WHERE id = ?").run(
        agentId,
      );
    });

    it("role='owner' (любой profile) → null — владелец не из семи", () => {
      expect(getRole(ownerId)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // isReviewer() — расширенное поведение
  // ─────────────────────────────────────────────────────────────────────

  describe("isReviewer: reviewer=1 ИЛИ role='Critic/Verifier' через profile", () => {
    it("reviewer=1 без profile=reviewer → true (старый путь)", () => {
      const id = (
        db.prepare("SELECT id FROM users WHERE email = ?").get(
          "matrix-owner@test",
        ) as { id?: string }
      )?.id;
      // Владелец временно становится ревьюером — нас интересует именно флаг.
      db.prepare("UPDATE users SET reviewer = 1 WHERE id = ?").run(id!);
      expect(isReviewer(id!)).toBe(true);
      db.prepare("UPDATE users SET reviewer = 0 WHERE id = ?").run(id!);
    });

    it("profile='reviewer' без reviewer=1 → true (новый путь)", () => {
      expect(isReviewer(reviewerNoFlagId)).toBe(true);
    });

    it("profile='claude_bot' → false (Builder не ревьюер)", () => {
      expect(isReviewer(agentId)).toBe(false);
    });

    it("profile=NULL и reviewer=0 → false (посторонний)", () => {
      db.prepare("UPDATE users SET profile = NULL WHERE id = ?").run(agentId);
      db.prepare("UPDATE users SET reviewer = 0 WHERE id = ?").run(agentId);
      expect(isReviewer(agentId)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // HTTP — agent-service: только preHandler, без systemctl
  // ─────────────────────────────────────────────────────────────────────

  async function apiToken(jwt: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${jwt}` },
    });
    return res.json().api_token as string;
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  describe("POST /api/agent-service: owner + orchestrator", () => {
    // Хендлер зовёт настоящий systemctl. На .110 он доступен, и тест с
    // {on:false} выключал ЖИВОЙ будильник при каждом прогоне (найдено
    // 23.09.2026). Подставляем пустышку, как в agentServiceResponse.test.ts.
    let fakeBin = "";
    let originalPath: string | undefined;
    beforeAll(async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-systemctl-"));
      const stub = path.join(fakeBin, "systemctl");
      fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(stub, 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    });
    afterAll(async () => {
      process.env.PATH = originalPath;
      const fs = await import("node:fs");
      fs.rmSync(fakeBin, { recursive: true, force: true });
    });

    it("агент (type='ai', role='agent') получает 403", async () => {
      const jwt = await login("matrix-agent@test");
      const token = await apiToken(jwt);
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-service",
        headers: { authorization: `Bearer ${token}` },
        payload: { on: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("owner_or_orchestrator_only");
    });

    it("orchestrator проходит preHandler (не 403)", async () => {
      const jwt = await login("matrix-orch@test");
      const token = await apiToken(jwt);
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-service",
        headers: { authorization: `Bearer ${token}` },
        payload: { on: false },
      });
      // До хендлера с systemctl preHandler пускает — значит код ответа НЕ 403.
      // В тесте systemctl может не сработать (нет user-bus в прогоне) — это
      // 500, а не 403. Главное, что ворота открыты.
      expect(res.statusCode).not.toBe(403);
    });

    it("owner проходит preHandler (не 403)", async () => {
      const jwt = await login("matrix-owner@test");
      const token = await apiToken(jwt);
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-service",
        headers: { authorization: `Bearer ${token}` },
        payload: { on: false },
      });
      expect(res.statusCode).not.toBe(403);
    });

    it("GET /api/agent-service доступен всем авторизованным", async () => {
      const jwt = await login("matrix-agent@test");
      const token = await apiToken(jwt);
      const res = await app.inject({
        method: "GET",
        url: "/api/agent-service",
        headers: { authorization: `Bearer ${token}` },
      });
      // GET не требует owner — это статус, не тумблер. statusCode не 401/403.
      expect([200, 500]).toContain(res.statusCode);
    });
  });
});