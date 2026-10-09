// Папка заметок проекта (08.10.2026, владелец: «документация проекта
// должна жить под Library/Projects, не в корне Дневника»).
//
// Раньше with_docs=true создавал top-level папку в journal_folders:
// мультишумные папки захламляли корень. После появления единой корневой
// папки библиотеки знаний (is_kb_root=1, миграция 119) проекты с
// with_docs=true должны ложиться под «Library/Projects», а не на верхний
// уровень. Если Library/Projects не инициализирован — fallback на старую
// схему, чтобы процесс создания проекта не ломался на чистой инсталляции.
//
// Проверяется через HTTP (app.inject, временная БД — test/setup.ts) и
// напрямую по journal_folders, потому что поведение зависит от схемы,
// а GET /api/projects папки не возвращает.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Папка заметок проекта: Library/Projects и top-level fallback", () => {
  let app: FastifyInstance;
  let ownerHeaders: Record<string, string>;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "ProjectsOwner",
        email: `projects-owner-${Date.now()}@test.local`,
        password: "password123",
      },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    ownerId = body.user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    ownerHeaders = { authorization: `Bearer ${body.token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  async function createProject(name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: ownerHeaders,
      payload: { name, with_docs: true },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      id: string;
      name: string;
      notes_folder_id: number | null;
    };
  }

  /** Состояние интересующих нас колонок проекта и его папки. */
  function inspect(projectId: string) {
    const project = db
      .prepare(
        "SELECT id, name, notes_folder_id FROM projects WHERE id = ?",
      )
      .get(projectId) as
      | { id: string; name: string; notes_folder_id: number | null }
      | undefined;
    if (!project || project.notes_folder_id == null) {
      return { project, folder: undefined };
    }
    const folder = db
      .prepare(
        "SELECT id, parent_id, name, position, is_kb_root FROM journal_folders WHERE id = ?",
      )
      .get(project.notes_folder_id) as
      | {
          id: number;
          parent_id: number | null;
          name: string;
          position: number;
          is_kb_root: number;
        }
      | undefined;
    return { project, folder };
  }

  /** Сбрасывает всё, что могло остаться от Library в этой временной БД:
   *  нетронутый предыдущим тестом мир для каждого сценария. */
  function clearLibrary() {
    db.exec("DELETE FROM journal_folders");
  }

  it("happy-path: with_docs=true создаёт папку под Library/Projects, если корень есть", async () => {
    clearLibrary();
    // Bootstrap библиотеки: корень с is_kb_root=1 и подпапка Projects.
    const libRes = db
      .prepare(
        "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (NULL, 'TaskFlow Library', 0, 1)",
      )
      .run();
    const libraryId = Number(libRes.lastInsertRowid);
    const projectsRes = db
      .prepare(
        "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (?, 'Projects', 0, 0)",
      )
      .run(libraryId);
    const projectsId = Number(projectsRes.lastInsertRowid);

    const created = await createProject("Документация под Library");
    expect(created.notes_folder_id).not.toBeNull();

    const { project, folder } = inspect(created.id);
    expect(project?.notes_folder_id).toBe(created.notes_folder_id);
    // Папка — ребёнок Projects, а не корень Дневника.
    expect(folder?.parent_id).toBe(projectsId);
    expect(folder?.is_kb_root).toBe(0);
    expect(folder?.name).toBe("Документация под Library");
    // И сам Projects не должен был стать чьим-то ребёнком.
    const projectsRow = db
      .prepare("SELECT parent_id FROM journal_folders WHERE id = ?")
      .get(projectsId) as { parent_id: number | null };
    expect(projectsRow.parent_id).toBe(libraryId);
  });

  it("fallback: без Library/Projects папка ложится top-level, проект всё равно получает notes_folder_id", async () => {
    clearLibrary();
    // Никакого корневого Library — только top-level папки, которые могут
    // существовать от прошлых установок или случайных записей.
    const stray = db
      .prepare(
        "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (NULL, 'Старая папка', 0, 0)",
      )
      .run();
    expect(stray.lastInsertRowid).toBeGreaterThan(0);

    const created = await createProject("Проект без библиотеки");
    expect(created.notes_folder_id).not.toBeNull();

    const { project, folder } = inspect(created.id);
    expect(project?.notes_folder_id).toBe(created.notes_folder_id);
    // Fallback: parent_id == NULL, как было до появления Library.
    expect(folder?.parent_id).toBeNull();
    expect(folder?.name).toBe("Проект без библиотеки");
    expect(folder?.is_kb_root).toBe(0);
    // Никакой папки с is_kb_root=1 не появилось (мы её не заводили).
    const kbRoots = db
      .prepare(
        "SELECT COUNT(*) AS n FROM journal_folders WHERE is_kb_root = 1",
      )
      .get() as { n: number };
    expect(kbRoots.n).toBe(0);
  });

  it("notes_folder_id сохраняется в строке проекта и указывает на реальную папку", async () => {
    clearLibrary();
    // Чистый кейс «поле есть и не врёт»: поднимаем Library/Projects,
    // создаём проект и читаем projects.notes_folder_id напрямую — это
    // ровно то поле, которое показывает карточка проекта в UI.
    db.prepare(
      "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (NULL, 'TaskFlow Library', 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES ((SELECT id FROM journal_folders WHERE is_kb_root=1 LIMIT 1), 'Projects', 0, 0)",
    ).run();

    const created = await createProject("Проверка notes_folder_id");
    expect(created.notes_folder_id).not.toBeNull();

    // Та же строка через прямой SELECT — значение из API и БД совпадают.
    const row = db
      .prepare(
        "SELECT notes_folder_id FROM projects WHERE id = ?",
      )
      .get(created.id) as { notes_folder_id: number | null };
    expect(row.notes_folder_id).toBe(created.notes_folder_id);

    // И папка существует, и она ровно та, на которую указывает id.
    const folder = db
      .prepare("SELECT id, name FROM journal_folders WHERE id = ?")
      .get(row.notes_folder_id) as { id: number; name: string } | undefined;
    expect(folder?.id).toBe(row.notes_folder_id);
    expect(folder?.name).toBe("Проверка notes_folder_id");
  });
});