import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { resetJevSettings } from "../src/lib/jev.js";

const getEmbeddings = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/embeddingClient.js", () => ({ getEmbeddings }));

import { selectSkillsByJev } from "../src/lib/memorySkillsJev.js";

beforeAll(() => { migrate(); runMigrations(); });

beforeEach(() => {
  resetJevSettings(); // JEV выключен: проверяем только локальный резерв.
  getEmbeddings.mockReset();
});

it("выбирает youtube-research локальным BGE при недоступном JEV", async () => {
  const skills = [
    {
      name: "youtube-research",
      description: "Используй, когда прислали youtube.com, youtu.be или просят разобрать видео YouTube.",
    },
    ...Array.from({ length: 6 }, (_, i) => ({ name: "other-" + i, description: "несвязанный навык" })),
  ];
  getEmbeddings.mockResolvedValue({
    embeddings: [[1, 0], [0.9, 0.1]],
    dim: 2,
    durationMs: 1,
  });

  const selected = await selectSkillsByJev(
    { title: "Разбери это видео", description: "https://youtu.be/dQw4w9WgXcQ" },
    skills,
  );

  expect(selected?.has("youtube-research")).toBe(true);
  expect(getEmbeddings).toHaveBeenCalledWith(
    expect.arrayContaining([expect.stringContaining("YouTube")]),
    expect.objectContaining({ purpose: "skill_selection_bge" }),
  );
});
