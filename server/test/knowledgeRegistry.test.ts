// Реестр датасетов базы знаний: что включено в TaskFlow, по каким разделам
// разложено и каким ролям выдано. Проверяется только реестр — ответы RAGFlow
// здесь не нужны, чужой индекс в тестах не задействован.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  MEMORY_DATASET_ID,
  createSection,
  datasetRegistryRow,
  datasetRoles,
  deleteSection,
  enabledDatasetIds,
  ensureDatasetRows,
  listSections,
  patchDataset,
  roleDatasetIds,
  setDatasetRoles,
  updateSection,
} from "../src/lib/knowledgeRegistry.js";

beforeAll(async () => {
  // Схему создаёт сборка приложения: миграции запускаются в buildApp().
  await buildApp();
});

beforeEach(() => {
  db.exec("DELETE FROM knowledge_dataset_roles");
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY_DATASET_ID}'`);
  db.exec("DELETE FROM knowledge_dataset_sections");
});

describe("реестр датасетов", () => {
  it("исключает память и включает остальные при первом чтении", () => {
    ensureDatasetRows([MEMORY_DATASET_ID, "ds-project"]);
    expect(datasetRegistryRow(MEMORY_DATASET_ID)?.enabled).toBe(0);
    expect(datasetRegistryRow("ds-project")?.enabled).toBe(1);
    expect(enabledDatasetIds()).toEqual(["ds-project"]);
  });

  it("не сбрасывает решение владельца при повторном чтении списка RAGFlow", () => {
    ensureDatasetRows(["ds-project"]);
    patchDataset("ds-project", { enabled: false });
    ensureDatasetRows(["ds-project"]);
    expect(datasetRegistryRow("ds-project")?.enabled).toBe(0);
  });

  it("создаёт раздел в конец и переставляет", () => {
    const a = createSection("Проекты");
    const b = createSection("Исследования");
    expect([a.position, b.position]).toEqual([0, 1]);
    updateSection(b.id, { position: 0 });
    expect(listSections().map((s) => s.title)).toEqual(["Исследования", "Проекты"]);
  });

  it("удаление раздела оставляет датасеты без раздела", () => {
    const section = createSection("Проекты");
    ensureDatasetRows(["ds-project"]);
    patchDataset("ds-project", { section_id: section.id });
    expect(deleteSection(section.id)).toBe(true);
    expect(datasetRegistryRow("ds-project")?.section_id).toBeNull();
    expect(listSections()).toHaveLength(0);
  });

  it("считает в разделе только включённые датасеты", () => {
    const section = createSection("Проекты");
    ensureDatasetRows(["ds-on", "ds-off"]);
    patchDataset("ds-on", { section_id: section.id });
    patchDataset("ds-off", { section_id: section.id, enabled: false });
    expect(listSections()[0].dataset_count).toBe(1);
  });

  it("выдача ролей заменяется целым набором", () => {
    ensureDatasetRows(["ds-project"]);
    setDatasetRoles("ds-project", ["researcher", "builder", "нет-такой"]);
    expect(datasetRoles("ds-project").map((r) => r.key).sort()).toEqual(["builder", "researcher"]);
    setDatasetRoles("ds-project", ["qa"]);
    expect(datasetRoles("ds-project").map((r) => r.key)).toEqual(["qa"]);
  });

  it("роль ищет только выданное и включённое", () => {
    ensureDatasetRows(["ds-a", "ds-b"]);
    setDatasetRoles("ds-a", ["researcher"]);
    setDatasetRoles("ds-b", ["researcher"]);
    patchDataset("ds-b", { enabled: false });
    expect(roleDatasetIds("researcher")).toEqual(["ds-a"]);
    expect(roleDatasetIds("builder")).toEqual([]);
  });
});
