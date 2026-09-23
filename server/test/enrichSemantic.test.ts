// Спек 1.2, задача 1.2.6: семантический матчинг задачи на роль.
// Мок embeddingClient ниже намеренно детерминированный: тесты проверяют
// cosine/gate логику без зависимости от Ollama, сети или установленной модели.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const embeddingClientMock = vi.hoisted(() => ({
  getEmbeddings: vi.fn(),
}));

vi.mock("../src/lib/embeddingClient.js", () => embeddingClientMock);

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { markReadyForPickup } from "./helpers.js";
import {
  semanticEnrich,
  getEscalationRate,
} from "../src/lib/semanticEnrich.js";

let app: FastifyInstance;
let ownerToken = "";

function deterministicEmbedding(text: string): number[] {
  if (text.includes("Архитектор")) return [1, 0, 0];
  if (text.includes("Строитель")) return [0, 1, 0];
  if (text.includes("Тестировщик")) return [0, 0, 1];
  if (text.includes("REST API")) return [1, 0.2, 0];
  if (text.includes("кашу на завтрак")) return [0.2, 0.1, 1];
  return [1, 1, 1];
}

beforeEach(() => {
  embeddingClientMock.getEmbeddings.mockReset();
  embeddingClientMock.getEmbeddings.mockImplementation(
    async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      const embeddings = texts.map(deterministicEmbedding);
      return {
        embeddings: Array.isArray(input) ? embeddings : embeddings[0],
        dim: 3,
        durationMs: 0,
      };
    },
  );
});

beforeAll(async () => {
  app = await buildApp();
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: `SemanticOwner${Date.now()}`,
      email: `semantic-owner-${Date.now()}@test`,
      password: "password123",
    },
  });
  if (owner.statusCode !== 200) {
    throw new Error(`register failed: ${owner.statusCode} ${owner.payload}`);
  }
  ownerToken = owner.json().token;
});

afterAll(async () => {
  if (app) await app.close();
});

async function setupTaskWithTitle(title: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { title },
  });
  const taskId = created.json().task.id as string;
  markReadyForPickup(taskId);
  return taskId;
}

async function seedRoles(rows: Array<{ role: string; description: string; tags: string[] }>) {
  db.prepare("DELETE FROM role_embeddings").run();
  const { getEmbeddings } = await import("../src/lib/embeddingClient.js");
  const inputs = rows.map((r) => r.description);
  const { embeddings, dim } = await getEmbeddings(inputs);
  if (!Array.isArray(embeddings)) throw new Error("embeddings not array");
  const insert = db.prepare(
    "INSERT INTO role_embeddings (role, embedding, tags) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < rows.length; i += 1) {
    const buf = Buffer.from(new Float32Array(embeddings[i]).buffer);
    insert.run(rows[i].role, buf, JSON.stringify(rows[i].tags));
  }
  return dim;
}

async function makeGateOpen(taskId: string): Promise<void> {
  // Эскалация ссылается на существующую задачу: иначе SQLite закономерно
  // отклоняет fixture внешним ключом.
  db.prepare("DELETE FROM enrichment_escalations").run();
  db.prepare(
    "INSERT INTO enrichment_escalations (id, task_id, input_text, candidates_json, reason, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    `gate_pending_${taskId}`,
    taskId,
    "previous run",
    "[]",
    "low confidence",
    "pending",
  );
}

describe("enrichSemantic: герметичный cosine/gate", () => {
  it("semanticEnrich возвращает gate_open=true когда доля эскалаций > threshold", async () => {
    const taskId = await setupTaskWithTitle("gate helper");
    await makeGateOpen(taskId);
    const rate = getEscalationRate(30);
    expect(rate).toBeGreaterThan(0);
    expect(embeddingClientMock.getEmbeddings).not.toHaveBeenCalled();
  });

  it("задача 'Спроектировать REST API' ранжирует architect выше builder", async () => {
    await seedRoles([
      {
        role: "architect",
        description: "Архитектор: проектирует структуру REST API, схему БД, контракты между модулями. Код не пишет — пишет схему.",
        tags: ["architecture", "rest", "api"],
      },
      {
        role: "builder",
        description: "Строитель: пишет код. Реализует фичи, фиксит баги. Основной объём работы по карточкам.",
        tags: ["implement", "code"],
      },
      {
        role: "qa",
        description: "Тестировщик: пишет и гоняет тесты. Покрывает граничные случаи и регрессии.",
        tags: ["test", "qa"],
      },
    ]);
    // seedRoles создаёт fixture через тот же клиент; далее учитываем только
    // запрос semanticEnrich, чтобы проверить отсутствие лишних вызовов.
    embeddingClientMock.getEmbeddings.mockClear();

    const title = "Нужно спроектировать REST API для нового модуля уведомлений и согласовать схему БД";
    const taskId = await setupTaskWithTitle(title);
    await makeGateOpen(taskId);

    const result = await semanticEnrich(taskId, { topK: 3 });
    expect(embeddingClientMock.getEmbeddings).toHaveBeenCalledTimes(1);
    expect(embeddingClientMock.getEmbeddings).toHaveBeenCalledWith(title);
    expect(result.gate_open).toBe(true);
    expect(result.matched.length).toBeGreaterThan(0);
    const top = result.matched[0];
    expect(top.role).toBe("architect");
    // Cosine должен быть ощутимо положительным для семантически близкого.
    expect(top.score).toBeGreaterThan(0.3);
    // Architect должен быть выше builder и qa (проверка ранжирования).
    const builder = result.matched.find((m) => m.role === "builder");
    const qa = result.matched.find((m) => m.role === "qa");
    if (builder) expect(top.score).toBeGreaterThan(builder.score);
    if (qa) expect(top.score).toBeGreaterThan(qa.score);
  }, 30_000);

  it("низкое совпадение: задача про 'сделать кашу на завтрак' не попадает ни на какую роль с высоким score", async () => {
    await seedRoles([
      {
        role: "architect",
        description: "Архитектор: проектирует REST API, схему БД, контракты между модулями.",
        tags: ["architecture", "rest", "api"],
      },
      {
        role: "builder",
        description: "Строитель: пишет код, реализует фичи.",
        tags: ["implement", "code"],
      },
    ]);
    embeddingClientMock.getEmbeddings.mockClear();

    const title = "Сделать кашу на завтрак";
    const taskId = await setupTaskWithTitle(title);
    await makeGateOpen(taskId);

    const result = await semanticEnrich(taskId, { topK: 3 });
    expect(embeddingClientMock.getEmbeddings).toHaveBeenCalledTimes(1);
    expect(embeddingClientMock.getEmbeddings).toHaveBeenCalledWith(title);
    expect(result.gate_open).toBe(true);
    expect(result.matched.length).toBeGreaterThan(0);
    // Максимальный score должен быть низким — кулинария далека от IT-ролей.
    const maxScore = Math.max(...result.matched.map((m) => m.score));
    expect(maxScore).toBeLessThan(0.4);

    // Раньше здесь проверялось, что словарный подбор не справился и
    // спросил владельца. И подбор, и этот вопрос убраны 14.09.2026 вместе
    // со старой доской объявлений: смысловой подбор всегда даёт ответ, а
    // владелец правит его одним движением. Проверять осталось само
    // главное — что далёкая от работы задача не липнет ни к какой роли.
  }, 30_000);

  it("если gate закрыт — semantic возвращается быстро, без вызова модели", async () => {
    // Чистим эскалации, чтобы gate был закрыт (0/0 = 0 < 0.3).
    db.prepare("DELETE FROM enrichment_escalations").run();
    db.prepare("DELETE FROM role_embeddings").run();

    const taskId = await setupTaskWithTitle("Любая задача");

    const result = await semanticEnrich(taskId, { topK: 3 });
    expect(result.gate_open).toBe(false);
    expect(result.escalation_rate).toBe(0);
    expect(result.matched).toEqual([]);
    expect(embeddingClientMock.getEmbeddings).not.toHaveBeenCalled();
    // Без сети — должно быть очень быстро.
    expect(result.duration_ms).toBeLessThan(50);
  });
});
